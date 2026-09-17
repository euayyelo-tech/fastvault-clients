#!/usr/bin/env node
// FastVault overlay. Rewrites an upstream bitwarden/clients checkout into FastVault.
// Run from the repo root of a CLEAN checkout (CI, or the throwaway build worktree):
//   node fastvault/apply.mjs            apply + verify
//   node fastvault/apply.mjs --dry      report what would change, write nothing
// Every replacement is anchored: wrong match count => exit 1 (upstream drift; fix here, never in the tree).
// --dry is a full rehearsal, not a weaker check: writes go to an in-memory overlay that read() and
// verify() see, so a dry run proves the anchors AND the verification, and leaves the tree untouched.
// After building, fastvault/verify-build.mjs re-checks the packaged output for brand leaks.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const FV = join(ROOT, "fastvault");
const DRY = process.argv.includes("--dry");
const VERSION = readFileSync(join(FV, "version.txt"), "utf8").trim();
const REPO = "euayyelo-tech/fastvault-clients";
const SITE = "https://fastvault.app";
const VAULT = "https://vault.fastvault.app";
const FIREFOX_ID = "{5d0312ec-4a31-4081-b970-5ac6f03f9c19}";
const CHROME_IDS = []; // filled by plan B after the first store uploads, e.g. "chrome-extension://<id>/"

// ---------- shared scope ----------
// The ONE list of directories the brand sweep rewrites and verify() re-scans. Both sides must use
// the same list or the overlay gets a blind spot: until 2026.7.2 applyCode()'s sweep and verify()'s
// URL scan kept two separate, coincidentally-similar lists, so anything in neither (libs/importer,
// libs/key-management-ui, libs/auto-confirm, libs/logging-angular, libs/common's autofill
// constants, ...) was neither rewritten nor caught — the desktop Import screen shipped visible
// bitwarden.com/help links in the 2026.7.0 and 2026.7.1 releases because of exactly that.
// `libs` is walked whole on purpose. Do not replace it with sub-directories.
const REWRITE_ROOTS = ["apps/desktop/src", "apps/browser/src", "libs"];
// Files the sweep skips and verify() does not scan. Shared by both for the same reason as
// REWRITE_ROOTS: a file the sweep skips must not be a file verify() then fails on, and vice versa.
// (Named ALLOWED_URL_FILES before 2026.7.2, when it guarded only the URL scan.)
const EXCLUDED_FILES = [
  // Jest specs and Storybook stories: never compiled into a shipped app.
  /\.spec\.ts$/,
  /\.stories\.ts$/,
  // Storybook-only fixture/catalogue data that is not itself a .stories.ts file:
  // libs/components/src/stories/** and the browser autofill lit-stories/** mock data.
  /[\\/]stories[\\/]/,
  /[\\/]lit-stories[\\/]/,
  // Bitwarden's own phishing-domain feed URL (assets.bitwarden.com). Behind the
  // `phishing-detection` flag, which Vaultwarden never turns on — see fastvault/README.md.
  /phishing-resources\.ts$/,
  // LastPass direct import is documented as non-functional in this fork (it needs an OAuth
  // redirect registered to Bitwarden's own client id); its bitwarden:// scheme is rewritten by a
  // dedicated anchored rule in applyCode() instead.
  /lastpass-direct-import\.service\.ts$/,
  // Importer test fixtures (libs/importer/src/importers/spec-data/**): saved-website sample data,
  // where "https://bitwarden.com" is the *content of a test vault item*, not a brand reference.
  // NOTE: the separator class must accept "\\" — join() produces backslashes on Windows, which is
  // what CI runs on, so the old /\/importers\// spelling never matched anything there.
  /[\\/]importers[\\/]/,
];
// HTML body-text check only (see verify()): the quoted-literal scan still covers these files.
const ALLOWED_HTML_TEXT_FILES = [
  // "© {{year}} Bitwarden Inc." — web-vault-only. anon-layout.component.ts's `hideYearAndVersion`
  // is true on desktop and browser (ClientType check, ~line 97), so this line is never rendered by
  // anything this fork builds. Confirmed inert in the 2026-09-17 review; left alone deliberately.
  /anon-layout\.component\.html$/,
];

const log = (...a) => console.log("[fastvault]", ...a);
const fail = (msg) => {
  console.error("[fastvault] FAIL:", msg);
  process.exit(1);
};
const rel = (p) => p.replace(ROOT + "\\", "").replace(ROOT + "/", "");
// --dry writes into an in-memory overlay instead of the disk, and read() prefers it. Without this
// the run was guaranteed to fail: write() was a no-op but verify() re-read the untouched files and
// reported every single rewrite as an unfixed "residual" (hundreds of false failures), so --dry
// could never be used for what it is for. Paths are normalised because the explicit rules pass
// forward-slash paths while walk() yields OS-native ones.
const overlay = new Map();
const key = (p) => p.replace(/\\/g, "/");
const read = (p) =>
  overlay.has(key(p)) ? overlay.get(key(p)) : readFileSync(join(ROOT, p), "utf8");
const write = (p, s) => {
  if (DRY) overlay.set(key(p), s);
  else writeFileSync(join(ROOT, p), s);
};

// replaceExact: `from` must occur exactly `count` times (default 1).
function replaceExact(file, from, to, count = 1) {
  const s = read(file);
  const n = s.split(from).length - 1;
  if (n !== count)
    fail(
      `${file}: expected ${count} match(es) of ${JSON.stringify(from.slice(0, 60))}, found ${n}`,
    );
  write(file, s.split(from).join(to));
  log(`${file}: ${n}x ${JSON.stringify(from.slice(0, 40))} -> ${JSON.stringify(to.slice(0, 40))}`);
}
// replaceBlock: from the line containing `start` up to and including the first line that equals `end` (trimmed).
function replaceBlock(file, start, end, replacement) {
  const lines = read(file).split("\n");
  const i = lines.findIndex((l) => l.includes(start));
  if (i < 0) fail(`${file}: block start not found: ${start}`);
  const j = lines.findIndex((l, k) => k > i && l.trim() === end);
  if (j < 0) fail(`${file}: block end not found: ${end}`);
  lines.splice(i, j - i + 1, replacement);
  write(file, lines.join("\n"));
  log(`${file}: replaced block ${start} .. ${end} (${j - i + 1} lines)`);
}
// removeElement: delete the nearest `open`..`close` block (default <bit-item>..</bit-item>) that
// wraps the single line containing `anchor`. Walks up/down from that line rather than matching the
// anchor's own block directly, since the anchor is inside the block, not the block's boundary.
function removeElement(file, anchor, open = "<bit-item>", close = "</bit-item>") {
  const lines = read(file).split("\n");
  const hits = lines.map((l, i) => (l.includes(anchor) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) fail(`${file}: expected 1 line with ${anchor}, found ${hits.length}`);
  let a = hits[0],
    b = hits[0];
  while (a >= 0 && lines[a].trim() !== open) a--;
  while (b < lines.length && lines[b].trim() !== close) b++;
  if (a < 0 || b >= lines.length) fail(`${file}: ${open}/${close} not found around ${anchor}`);
  lines.splice(a, b - a + 1);
  write(file, lines.join("\n"));
  log(`${file}: removed ${open} block around ${anchor} (${b - a + 1} lines)`);
}
// replaceRegexMin: at least `min` replacements across the file. Requires (coerces to) a global regex —
// without the `g` flag, String#match returns one match (or its capture groups, miscounting) and
// String#replace touches only the first occurrence, silently breaking the anchored-replacement contract.
function replaceRegexMin(file, re, to, min = 1) {
  const g = re.global
    ? re
    : new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const s = read(file);
  const n = (s.match(g) || []).length;
  if (n < min) fail(`${file}: expected >=${min} match(es) of ${g}, found ${n}`);
  write(file, s.replace(g, to));
  return n;
}
function editJson(file, fn) {
  const j = JSON.parse(read(file));
  fn(j);
  write(file, JSON.stringify(j, null, 2) + "\n");
  log(`${file}: json edited`);
}
function copy(srcRel, dstRel) {
  const src = join(FV, srcRel),
    dst = join(ROOT, dstRel);
  if (!existsSync(src)) fail(`missing overlay asset ${srcRel}`);
  if (!existsSync(dst)) fail(`upstream asset moved: ${dstRel}`);
  if (!DRY) copyFileSync(src, dst);
  log(`copy ${srcRel} -> ${dstRel}`);
}
function remove(p) {
  if (!existsSync(join(ROOT, p))) fail(`expected to delete ${p} but it is not there`);
  if (!DRY) unlinkSync(join(ROOT, p));
  log(`delete ${p}`);
}
function* walk(dir, filter) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") yield* walk(p, filter);
    } else if (filter(p)) yield p;
  }
}

// ---------- 1. assets ----------
function applyAssets() {
  const G = "branding/generated";
  copy(`${G}/desktop/icon.ico`, "apps/desktop/resources/icon.ico");
  copy(`${G}/desktop/icon-1024.png`, "apps/desktop/resources/icon.png");
  for (const s of [16, 32, 64, 128, 256, 512, 1024])
    copy(`${G}/desktop/icons/${s}x${s}.png`, `apps/desktop/resources/icons/${s}x${s}.png`);
  copy(`${G}/desktop/icon.ico`, "apps/desktop/src/images/icon.ico");
  copy(`${G}/desktop/icon-512.png`, "apps/desktop/src/images/icon.png");
  for (const f of [
    "icon-template.png",
    "icon-template@2x.png",
    "icon-highlight.png",
    "icon-highlight@2x.png",
    "logo-dark@2x.png",
    "logo-white@2x.png",
  ])
    copy(`${G}/desktop/${f}`, `apps/desktop/src/images/${f}`);
  remove("apps/desktop/resources/installerSidebar.bmp");
  copy("branding/logo.icon.ts", "libs/assets/src/svg/svgs/bitwarden-logo.icon.ts");
  copy("branding/shield.icon.ts", "libs/assets/src/svg/svgs/shield.ts");
  // browser assets are wired by plan B (applyBrowserAssets) — the files already exist under generated/browser.
}

// ---------- 2. strings ----------
const LOCALE_DIRS = [
  { app: "desktop", dir: "apps/desktop/src/locales" },
  { app: "browser", dir: "apps/browser/src/_locales" },
];
// Illustrative self-hosted-server URL example ("Specify the base URL of your on-premises hosted
// Bitwarden installation. Example: https://bitwarden.company.com") — not a mention of Bitwarden's
// own cloud, the word is filler for a hypothetical subdomain. Matched by shape (bitwarden.<word>.com)
// rather than the literal English "company", because some locales translate the filler word
// ("company" -> French "compagnie", Galician "compañia") and both still start with "com" — so a
// plain "bitwarden.com" substring replace would fire mid-word there and corrupt the host into a
// garbled "fastvault.app<remainder>" domain instead of leaving a clean example.
const SELF_HOSTED_URL_RE = /https:\/\/bitwarden\.[^\s<]+\.com/g;
function applyStrings() {
  const drop = JSON.parse(readFileSync(join(FV, "strings/drop-from-other-locales.json"), "utf8"));
  for (const { app, dir } of LOCALE_DIRS) {
    const overrides = JSON.parse(
      readFileSync(join(FV, `strings/overrides.${app}.en.json`), "utf8"),
    );
    let files = 0,
      hits = 0,
      domainHits = 0;
    for (const loc of readdirSync(join(ROOT, dir))) {
      const file = `${dir}/${loc}/messages.json`;
      if (!existsSync(join(ROOT, file))) continue;
      const j = JSON.parse(read(file));
      for (const [k, v] of Object.entries(j)) {
        if (!(v && typeof v.message === "string")) continue;
        if (v.message.includes("Bitwarden")) {
          v.message = v.message.split("Bitwarden").join("FastVault");
          hits++;
        }
        // Lowercase "bitwarden.com" surviving in prose — a DOMAIN reference, separate from the
        // brand-NAME rename above (until 2026.7.3 nothing renamed this: e.g. "...set up on the
        // bitwarden.com web vault.", "user@bitwarden.com, user@acme.com").
        if (k === "selfHostedBaseUrlHint") {
          const n = (v.message.match(SELF_HOSTED_URL_RE) || []).length;
          if (n) {
            v.message = v.message.replace(SELF_HOSTED_URL_RE, "https://vault.company.com");
            domainHits += n;
          }
        } else if (v.message.includes("bitwarden.com")) {
          v.message = v.message.split("bitwarden.com").join("fastvault.app");
          domainHits++;
        }
      }
      if (loc === "en") {
        for (const [k, v] of Object.entries(overrides)) j[k] = v;
      } else {
        for (const k of drop) delete j[k];
      }
      write(file, JSON.stringify(j, null, 2) + "\n");
      files++;
    }
    if (files < 50) fail(`${dir}: only ${files} locale files — did the layout change?`);
    log(
      `${app}: ${files} locale files, ${hits} brand mentions renamed, ${domainHits} domain mentions renamed, ${Object.keys(overrides).length} overrides`,
    );
  }
  // Store listing texts (plan B uses them; renaming now is harmless and keeps one rule).
  // These are .resx, not .json — until 2026.7.2 this loop filtered for ".json", matched nothing,
  // and logged "0 files renamed" indistinguishably from "correctly found nothing to rename".
  // The anchor is therefore the FILE COUNT, not the rename count: 0 renames can be legitimate once
  // the strings are already FastVault's, but 0 .resx files found means the layout moved.
  const storeDir = "apps/browser/store/locales";
  let seen = 0,
    n = 0,
    domainN = 0;
  for (const f of walk(storeDir, (p) => p.endsWith(".resx"))) {
    seen++;
    let s = read(f);
    let changed = false;
    if (s.includes("Bitwarden")) {
      s = s.split("Bitwarden").join("FastVault");
      n++;
      changed = true;
    }
    // Same lowercase-domain gap as the messages.json sweep above — found live in the Estonian and
    // Portuguese (Brazil) store descriptions ("...Külasta veebilehte bitwarden.com..." / "...Visite
    // bitwarden.com...").
    if (s.includes("bitwarden.com")) {
      s = s.split("bitwarden.com").join("fastvault.app");
      domainN++;
      changed = true;
    }
    if (changed) write(f, s);
  }
  if (seen === 0) fail(`${storeDir}: no .resx files found — did the store-locale layout change?`);
  log(`store locales: ${seen} .resx files, ${n} brand renames, ${domainN} domain renames`);
}

// ---------- 3. config (JSON) ----------
function applyConfig() {
  editJson("apps/desktop/electron-builder.json", (j) => {
    j.extraMetadata.name = "fastvault";
    j.productName = "FastVault";
    j.appId = "app.fastvault.desktop";
    j.copyright =
      "Copyright © FSITES LTD. Based on the Bitwarden clients © 2015-2026 Bitwarden Inc.";
    j.publish = {
      provider: "github",
      owner: "euayyelo-tech",
      repo: "fastvault-clients",
      releaseType: "release",
    };
    j.protocols = [{ name: "FastVault", schemes: ["fastvault"] }];
    j.win.target = ["nsis", "portable"];
    delete j.win.signtoolOptions;
    // Signing needs SIX env vars, split across two consumers: this script reads the three
    // AZURE_SIGN_* ones to write azureSignOptions into electron-builder.json, and
    // electron-builder itself reads the three AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET
    // credentials at packaging time. Configure one trio without the other and the build either
    // ships silently unsigned (SIGN_* missing) or dies deep inside electron-builder minutes later
    // (credentials missing). All six, or none.
    const AZURE_VARS = [
      "AZURE_SIGN_ENDPOINT",
      "AZURE_SIGN_ACCOUNT",
      "AZURE_SIGN_PROFILE",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
    ];
    const setVars = AZURE_VARS.filter((v) => (process.env[v] ?? "").trim() !== "");
    if (setVars.length !== 0 && setVars.length !== AZURE_VARS.length)
      fail(
        `code signing is half-configured: ${setVars.length}/6 AZURE_* vars set ` +
          `(missing ${AZURE_VARS.filter((v) => !setVars.includes(v)).join(", ")}). ` +
          `Set all six or none — a partial set ships an unsigned build or fails at packaging time.`,
      );
    const azure = setVars.length === AZURE_VARS.length;
    log(azure ? "code signing: all 6 AZURE_* vars present" : "code signing: off (no AZURE_* vars)");
    if (azure) {
      j.win.publisherName = "FSITES LTD";
      j.win.azureSignOptions = {
        endpoint: process.env.AZURE_SIGN_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
        certificateProfileName: process.env.AZURE_SIGN_PROFILE,
      };
    }
    j.nsis = {
      ...j.nsisWeb,
      artifactName: "FastVault-Installer-${version}.${ext}",
      license: "../../LICENSE_GPL.txt",
    };
    delete j.nsisWeb;
    j.portable.artifactName = "FastVault-Portable-${version}.${ext}";
    j.linux.desktop.entry.Name = "FastVault";
    j.linux.target = ["deb", "rpm", "AppImage"]; // no snap (Snap Store + unsquashfs post-step), no flatpak (Flathub)
    // Guarded like the package.json author/repository checks below: anchored on upstream's exact
    // value so a future upstream reword fails here instead of silently getting clobbered unnoticed.
    // (Unlike `target` just above, which we always want overwritten to our exact list regardless of
    // upstream's default — that one is deliberately left unguarded.)
    if (j.linux.synopsis !== "A secure and free password manager for all of your devices.")
      fail(`electron-builder.json: unexpected linux.synopsis ${JSON.stringify(j.linux.synopsis)}`);
    j.linux.synopsis = "FastVault password manager";
    j.snap.summary = "FastVault is a password manager for all of your devices.";
    j.snap.description = "Password manager.";
    if (!j.win.extraFiles?.some((e) => e.to === "bitwarden_chromium_import_helper.exe"))
      fail("electron-builder.json: chromium import helper entry moved");
    // Linux polkit action-prefix must match the renamed action id in os-biometrics-linux.service.ts
    // (com.bitwarden.Bitwarden.unlock -> app.fastvault.desktop.unlock) or the snap-packaged build's
    // declared polkit permission won't match what the app actually requests at runtime.
    const polkitPlug = j.snap.plugs?.find((p) => p && typeof p === "object" && p.polkit);
    if (!polkitPlug) fail("electron-builder.json: snap polkit plug entry moved");
    polkitPlug.polkit["action-prefix"] = "app.fastvault.desktop";
  });
  editJson("apps/desktop/package.json", (j) => {
    j.version = VERSION;
    j.description = "FastVault password manager";
    // electron-builder reads deb/rpm Maintainer/Homepage straight from this file's package
    // metadata (this is the project-level package.json electron-builder itself runs against, not
    // apps/desktop/src/package.json below, which only affects the app manifest bundled inside the
    // packaged app) — still Bitwarden Inc. today. Same guarded pattern as the src/package.json
    // block below: anchored on the upstream values so an upstream change fails here instead of
    // silently writing over something different.
    j.homepage = SITE;
    if (j.author !== "Bitwarden Inc. <hello@bitwarden.com> (https://bitwarden.com)")
      fail(`apps/desktop/package.json: unexpected author ${JSON.stringify(j.author)}`);
    j.author = "FSITES LTD <support@fastvault.app> (https://fastvault.app)";
    if (j.repository?.url !== "git+https://github.com/bitwarden/clients.git")
      fail(`apps/desktop/package.json: unexpected repository ${JSON.stringify(j.repository)}`);
    j.repository.url = `git+https://github.com/${REPO}.git`;
  });
  // apps/desktop/src/package.json is copied by webpack (CopyWebpackPlugin, webpack.base.js)
  // into build/package.json, the manifest actually bundled into the packaged app. It is what
  // Electron's app.getVersion() reads at runtime, so it (not apps/desktop/package.json above)
  // is what electron-updater compares against latest.yml's version. Left un-patched it silently
  // pins every build's reported version to upstream's 2026.7.0 forever, breaking auto-update.
  editJson("apps/desktop/src/package.json", (j) => {
    j.productName = "FastVault";
    j.description = "FastVault password manager";
    j.version = VERSION;
    j.homepage = SITE;
    // `author` and `repository` ship inside the packaged app (build/package.json) and still named
    // Bitwarden Inc. in 2026.7.0/2026.7.1. Anchored on the upstream values so an upstream change
    // fails here instead of silently writing over something different. `name` is deliberately left
    // as @bitwarden/desktop: it is the npm package identity, not shown anywhere, and Electron's
    // app.getName() already resolves to productName.
    if (j.author !== "Bitwarden Inc. <hello@bitwarden.com> (https://bitwarden.com)")
      fail(`apps/desktop/src/package.json: unexpected author ${JSON.stringify(j.author)}`);
    j.author = "FSITES LTD <support@fastvault.app> (https://fastvault.app)";
    if (j.repository?.url !== "git+https://github.com/bitwarden/clients.git")
      fail(`apps/desktop/src/package.json: unexpected repository ${JSON.stringify(j.repository)}`);
    j.repository.url = `git+https://github.com/${REPO}.git`;
  });
  editJson("apps/browser/src/manifest.json", (j) => {
    j.short_name = "FastVault";
    j.version = VERSION;
    j.homepage_url = SITE;
    j.__firefox__browser_specific_settings.gecko.id = FIREFOX_ID;
  });
  editJson("apps/browser/src/manifest.v3.json", (j) => {
    j.short_name = "FastVault";
    j.version = VERSION;
    j.homepage_url = SITE;
    j.__firefox__browser_specific_settings.gecko.id = FIREFOX_ID;
  });
}

// ---------- 4. code anchors ----------
function applyCode() {
  // Server default (spec §4.3)
  replaceBlock(
    "libs/common/src/platform/services/default-environment.service.ts",
    "export const PRODUCTION_REGIONS: RegionConfig[] = [",
    "];",
    `export const PRODUCTION_REGIONS: RegionConfig[] = [
  {
    key: Region.US,
    domain: "fastvault.app",
    urls: {
      base: "${VAULT}",
      api: null,
      identity: null,
      icons: null,
      webVault: "${VAULT}",
      notifications: null,
      events: null,
      scim: null,
      send: "${VAULT}",
    },
  },
];`,
  );
  // Legacy vanity-redirect special case for Bitwarden's own send domain — dead for FastVault
  // (our region's send URL is VAULT, not this literal), but still a residual brand reference.
  replaceExact(
    "libs/common/src/platform/services/default-environment.service.ts",
    `if (this.urls.send === "https://send.bitwarden.com") {`,
    `if (this.urls.send === "https://send.fastvault.app") {`,
  );

  // Desktop window <title>. window.main.ts sets the BrowserWindow's initial title from
  // app.name (already correct — see the page-title-updated guard below), but Electron lets the
  // loaded page's document.title override it once the page finishes loading, and that title is
  // sourced from this hardcoded HTML tag — so the correct initial title got silently clobbered
  // with "Bitwarden" the moment the Angular app loaded.
  replaceExact(
    "apps/desktop/src/index.html",
    `<title>Bitwarden</title>`,
    `<title>FastVault</title>`,
  );

  // Desktop menus and identity
  const help = "apps/desktop/src/main/menu/menu.help.ts";
  replaceExact(
    help,
    `      this.separator,\n      this.followUs,\n      this.separator,\n      this.goToWebVault,`,
    `      this.separator,\n      this.goToWebVault,`,
  );
  replaceExact(
    help,
    `      submenu: this.getMobileAppSubmenu,`,
    `      click: () => this.shell.openExternal("${SITE}/apps", UrlType.WebUrl),`,
  );
  replaceExact(
    help,
    `      submenu: this.getBrowserExtensionSubmenu,`,
    `      click: () => this.shell.openExternal("${SITE}/apps", UrlType.WebUrl),`,
  );
  replaceExact(
    help,
    `"https://github.com/bitwarden/clients/issues"`,
    `"https://github.com/${REPO}/issues"`,
  );
  replaceExact(help, `"https://bitwarden.com/help"`, `"${SITE}/support"`);
  replaceExact(
    "apps/desktop/src/main/menu/menu.main.ts",
    `const cloudWebVaultUrl = "https://vault.bitwarden.com";`,
    `const cloudWebVaultUrl = "${VAULT}";`,
  );
  replaceExact(
    "apps/desktop/src/main/menu/menu.bitwarden.ts",
    `readonly label: string = "Bitwarden";`,
    `readonly label: string = "FastVault";`,
  );
  const about = "apps/desktop/src/main/menu/menu.about.ts";
  replaceExact(
    about,
    `          title: "Bitwarden",\n          message: "Bitwarden",`,
    `          title: "FastVault",\n          message: "FastVault",`,
  );
  replaceExact(
    about,
    `          "\\nArchitecture " +\n          process.arch;`,
    `          "\\nArchitecture " +\n          process.arch +\n          "\\n\\n" +\n          this.localize("fastvaultAttribution");`,
  );
  const main = "apps/desktop/src/main.ts";
  replaceExact(main, `"bitwarden-appdata"`, `"fastvault-appdata"`);
  replaceExact(
    main,
    `app.removeAsDefaultProtocolClient("bitwarden");`,
    `app.removeAsDefaultProtocolClient("fastvault");`,
  );
  replaceExact(
    main,
    `app.setAsDefaultProtocolClient("bitwarden", process.execPath, [`,
    `app.setAsDefaultProtocolClient("fastvault", process.execPath, [`,
  );
  replaceExact(
    main,
    `app.setAsDefaultProtocolClient("bitwarden");`,
    `app.setAsDefaultProtocolClient("fastvault");`,
  );
  replaceExact(
    main,
    `.filter((s) => s.indexOf("bitwarden://") === 0)`,
    `.filter((s) => s.indexOf("fastvault://") === 0)`,
  );
  // Windows Credential Manager service name for the biometric key — separate from the official app's "Bitwarden" entries (line ~306)
  replaceExact(
    main,
    `new DesktopCredentialStorageListener(\n      "Bitwarden",`,
    `new DesktopCredentialStorageListener(\n      "FastVault",`,
  );
  replaceExact(main, `this.trayMain.init("Bitwarden", [`, `this.trayMain.init("FastVault", [`);
  replaceExact(
    "apps/desktop/src/utils.ts",
    `userAgentItem("Bitwarden", " ")`,
    `userAgentItem("FastVault", " ")`,
  );
  // Block the loaded page's document.title (index.html's <title>, renamed above) from ever
  // overriding the BrowserWindow's title (set correctly from app.name a few lines up) again —
  // the more permanent fix for the bug class, not just this one string.
  replaceExact(
    "apps/desktop/src/main/window.main.ts",
    `        devTools: isDev(),\n      },\n    });\n\n    if (template === "modal-app") {`,
    `        devTools: isDev(),\n      },\n    });\n\n    this.win.on("page-title-updated", (event) => event.preventDefault());\n\n    if (template === "modal-app") {`,
  );

  // Native messaging bridge (host name + allow-lists)
  const nm = "apps/desktop/src/main/native-messaging.main.ts";
  replaceRegexMin(nm, /com\.8bit\.bitwarden/g, "app.fastvault.desktop", 10);

  // IPC pipe/socket name. Upstream's "bw" becomes \\.\pipe\<sha256(home)>.s.bw on Windows —
  // the SAME name the official Bitwarden desktop app listens on. Side by side, the official
  // extension's proxy could reach our app (or ours theirs). "fastvault" makes the two apps
  // invisible to each other. The Rust proxy (the native-messaging host the browser launches)
  // must open the same name, so both sides change together; the Windows CI job compiles the
  // Rust side, which is the only place this is verified.
  replaceExact(nm, `ipc.NativeIpcServer.listen("bw", `, `ipc.NativeIpcServer.listen("fastvault", `);
  const proxy = "apps/desktop/desktop_native/proxy/src/main.rs";
  replaceExact(
    proxy,
    `desktop_core::ipc::all_paths("bw");`,
    `desktop_core::ipc::all_paths("fastvault");`,
  );
  replaceExact(
    proxy,
    `path.set_extension("bitwarden.log");`,
    `path.set_extension("fastvault.log");`,
  );
  replaceExact(
    proxy,
    `info!("Starting Bitwarden IPC Proxy.");`,
    `info!("Starting FastVault IPC Proxy.");`,
  );
  replaceExact(proxy, `/// Bitwarden IPC Proxy.`, `/// FastVault IPC Proxy.`);
  replaceExact(
    proxy,
    `NativeMessagingHosts/com.8bit.bitwarden.json`,
    `NativeMessagingHosts/app.fastvault.desktop.json`,
  );
  // Linux (and unsandboxed macOS): the socket lives under the cache dir named after the app id.
  // The macOS *sandboxed* branch keeps Bitwarden's App Group container id — it is bound to
  // their Apple team id and macOS is out of scope (spec §11).
  replaceExact(
    "apps/desktop/desktop_native/core/src/ipc/mod.rs",
    `let path_dir = home.join("com.bitwarden.desktop");`,
    `let path_dir = home.join("app.fastvault.desktop");`,
  );
  replaceExact(
    nm,
    `description: "Bitwarden desktop <-> browser bridge",`,
    `description: "FastVault desktop <-> browser bridge",`,
    2,
  );
  replaceExact(
    nm,
    `description: "Bitwarden desktop <-> DuckDuckGo bridge",`,
    `description: "FastVault desktop <-> DuckDuckGo bridge",`,
  );
  replaceExact(
    nm,
    `allowed_extensions: ["{446900e4-71c2-419f-a6a7-df9c091e268b}"],`,
    `allowed_extensions: ["${FIREFOX_ID}"],`,
  );
  replaceBlock(
    nm,
    `    const ids: Set<string> = new Set([`,
    `]);`,
    `    const ids: Set<string> = new Set([\n${CHROME_IDS.map((id) => `      "${id}",`).join("\n")}\n    ]);`,
  );

  // SSO localhost callback page (shown in the user's default browser after login completes)
  const ssoCallback = "apps/desktop/src/auth/services/sso-localhost-callback.service.ts";
  replaceExact(
    ssoCallback,
    `"<html><head><title>Success | Bitwarden Desktop</title></head><body>"`,
    `"<html><head><title>Success | FastVault Desktop</title></head><body>"`,
  );
  replaceExact(
    ssoCallback,
    `"<h1>Successfully authenticated with the Bitwarden desktop app</h1>"`,
    `"<h1>Successfully authenticated with the FastVault desktop app</h1>"`,
  );
  replaceExact(
    ssoCallback,
    `"<html><head><title>Failed | Bitwarden Desktop</title></head><body>"`,
    `"<html><head><title>Failed | FastVault Desktop</title></head><body>"`,
  );
  replaceExact(
    ssoCallback,
    `"<h1>Something went wrong logging into the Bitwarden desktop app</h1>"`,
    `"<h1>Something went wrong logging into the FastVault desktop app</h1>"`,
  );

  // Biometric key OS-credential-store service name — separate namespace from the general
  // "FastVault" keytar prefix (main.ts) and from the official app's own storage, to avoid
  // colliding with a real Bitwarden install's biometric key on the same machine.
  replaceExact(
    "apps/desktop/src/key-management/biometrics/os-biometrics-mac.service.ts",
    `const SERVICE = "Bitwarden_biometric";`,
    `const SERVICE = "FastVault_biometric";`,
  );
  replaceExact(
    "apps/desktop/src/key-management/biometrics/os-biometrics-mac.service.spec.ts",
    `const serviceName = "Bitwarden_biometric";`,
    `const serviceName = "FastVault_biometric";`,
  );
  replaceExact(
    "apps/desktop/src/platform/main/desktop-credential-storage-listener.ts",
    `if (serviceName == "Bitwarden_biometric") {`,
    `if (serviceName == "FastVault_biometric") {`,
  );

  // Linux polkit policy for biometric unlock — both the action id/filename (must match the
  // snap "action-prefix" set in applyConfig(), and must not collide with a real Bitwarden
  // install's own /usr/share/polkit-1/actions/ policy file) and the text shown in the OS auth
  // prompt itself.
  const linuxBiometrics =
    "apps/desktop/src/key-management/biometrics/native-v2/os-biometrics-linux.service.ts";
  replaceExact(
    linuxBiometrics,
    `<action id="com.bitwarden.Bitwarden.unlock">`,
    `<action id="app.fastvault.desktop.unlock">`,
  );
  replaceExact(
    linuxBiometrics,
    `<description>Unlock Bitwarden</description>`,
    `<description>Unlock FastVault</description>`,
  );
  replaceExact(
    linuxBiometrics,
    `<message>Authenticate to unlock Bitwarden</message>`,
    `<message>Authenticate to unlock FastVault</message>`,
  );
  replaceExact(
    linuxBiometrics,
    `const policyFileName = "com.bitwarden.Bitwarden.policy";`,
    `const policyFileName = "app.fastvault.desktop.policy";`,
  );

  // Linux: the packaged real binary is renamed by after-pack.js and exec'd by the wrapper script that
  // takes its place — that name is what `ps`/system monitors show. Both sides must agree.
  replaceRegexMin("apps/desktop/scripts/after-pack.js", /bitwarden-app/g, "fastvault-app", 2);
  replaceRegexMin("apps/desktop/resources/linux-wrapper.sh", /bitwarden-app/g, "fastvault-app", 2);
  // Snap/flatpak-only resource files: not used by the deb/rpm/AppImage targets we build, but they are
  // Linux artefacts in this repo that still said Bitwarden. Contents rebranded; filenames kept because
  // only the (unused) snap/flatpak scripts reference them by name.
  const desktopFile = "apps/desktop/resources/com.bitwarden.desktop.desktop";
  replaceExact(desktopFile, "Name=Bitwarden", "Name=FastVault");
  replaceExact(desktopFile, "Exec=bitwarden %u", "Exec=fastvault %u");
  replaceExact(desktopFile, "Icon=com.bitwarden.desktop", "Icon=app.fastvault.desktop");
  replaceExact(
    desktopFile,
    "StartupWMClass=com.bitwarden.desktop",
    "StartupWMClass=app.fastvault.desktop",
  );
  replaceExact(
    desktopFile,
    "Comment=A secure and free password manager for all of your devices.",
    "Comment=FastVault password manager",
  );
  replaceExact(
    desktopFile,
    "MimeType=x-scheme-handler/bitwarden;",
    "MimeType=x-scheme-handler/fastvault;",
  );
  const policyFile = "apps/desktop/resources/com.bitwarden.desktop.policy";
  replaceExact(
    policyFile,
    `<action id="com.bitwarden.Bitwarden.unlock">`,
    `<action id="app.fastvault.desktop.unlock">`,
  );
  replaceExact(
    policyFile,
    "<description>Unlock Bitwarden</description>",
    "<description>Unlock FastVault</description>",
  );
  replaceExact(
    policyFile,
    "<message>Authenticate to unlock Bitwarden</message>",
    "<message>Authenticate to unlock FastVault</message>",
  );

  // URL schemes used by callbacks (SSO / Duo / LastPass — see spec §7)
  replaceExact(
    "libs/auth/src/common/services/sso-redirect/sso-url.service.ts",
    `"bitwarden://sso-callback"`,
    `"fastvault://sso-callback"`,
  );
  replaceRegexMin(
    "apps/desktop/src/app/app.component.ts",
    /bitwarden:\/\/(sso-cookie-vendor|duo-callback|import-callback-lp)/g,
    "fastvault://$1",
    3,
  );
  replaceRegexMin(
    "libs/importer/src/components/lastpass/lastpass-direct-import.service.ts",
    /bitwarden:\/\//g,
    "fastvault://",
    2,
  );

  // ---- brought in scope by the 2026.7.2 widening of REWRITE_ROOTS ----
  // Every vault export was written as bitwarden_export_<date>.json (and bitwarden_org_export_...,
  // bitwarden_encrypted_export_...). The prefix is the only brand string; the file FORMAT is
  // unchanged, so a FastVault export still imports into any Bitwarden-compatible client.
  const exportHelper = "libs/tools/export-vault-core/src/services/export-helper.ts";
  replaceExact(
    exportHelper,
    `    return "bitwarden" + (prefix ? "_" + prefix : "") + "_export_" + dateString + "." + format;`,
    `    return "fastvault" + (prefix ? "_" + prefix : "") + "_export_" + dateString + "." + format;`,
  );
  // ...and the spec that pins the old prefix, so `npm test` stays honest about the rename.
  replaceRegexMin(
    `${exportHelper.replace(/\.ts$/, ".spec.ts")}`,
    /\^bitwarden_/g,
    "^fastvault_",
    5,
  );

  // Import screen. The format picker's own labels named the upstream brand for a format FastVault
  // itself produces, and the per-format help text told the user to upload their file "to
  // Bitwarden". The option IDS (bitwardenjson / bitwardencsv / bitwardenpasswordprotected) are the
  // persisted, on-the-wire format identifiers and are deliberately NOT renamed — only the labels.
  const importOptions = "libs/importer/src/models/import-options.ts";
  replaceExact(
    importOptions,
    `{ id: "bitwardenjson", name: "Bitwarden (json)" }`,
    `{ id: "bitwardenjson", name: "FastVault (json)" }`,
  );
  replaceExact(
    importOptions,
    `{ id: "bitwardencsv", name: "Bitwarden (csv)" }`,
    `{ id: "bitwardencsv", name: "FastVault (csv)" }`,
  );
  replaceExact(
    "libs/importer/src/components/import.component.html",
    `          resulting <code>my_passwords.json</code> file here to Bitwarden.`,
    `          resulting <code>my_passwords.json</code> file here to FastVault.`,
  );

  // Flight-recorder diagnostic export: another generated FILE NAME carrying the upstream brand
  // (Bitwarden-diagnostic-report-YYYY-MM-DD.csv). It is a template literal, which is why the
  // double-quote-only literal scan never saw it — verify() now checks backtick spans too.
  const flightRecorder = "libs/logging/src/flight-recorder-export.ts";
  replaceRegexMin(flightRecorder, /Bitwarden-diagnostic-report/g, "FastVault-diagnostic-report", 2);
  replaceRegexMin(
    "libs/logging/src/flight-recorder-export.spec.ts",
    /Bitwarden-diagnostic-report/g,
    "FastVault-diagnostic-report",
    4,
  );
  // Firefox sidebar-action tooltip (browser extension).
  replaceExact(
    "apps/browser/src/platform/badge/badge-browser-api.ts",
    'const title = `Bitwarden${Utils.isNullOrEmpty(text) ? "" : ` [${text}]`}`;',
    'const title = `FastVault${Utils.isNullOrEmpty(text) ? "" : ` [${text}]`}`;',
  );

  // Self-referential entry in the generator's vendor registry. The id (Vendor.bitwarden) is a
  // persisted identifier and stays; `name` is the brand name rendered for a vendor's extensions.
  replaceExact(
    "libs/common/src/tools/extension/vendor/bitwarden.ts",
    `  name: "Bitwarden",`,
    `  name: "FastVault",`,
  );

  // Browser extension surfaces (plan B builds the extension; these are rewritten now so the
  // widened verify() has nothing left to trip on and plan B starts from a clean base).
  for (const [f, from, to] of [
    [
      "apps/browser/src/autofill/notification/bar.html",
      `<title>Bitwarden</title>`,
      `<title>FastVault</title>`,
    ],
    [
      "apps/browser/src/autofill/overlay/inline-menu/pages/button/button.html",
      `<title>Bitwarden inline menu button</title>`,
      `<title>FastVault inline menu button</title>`,
    ],
    [
      "apps/browser/src/autofill/overlay/inline-menu/pages/list/list.html",
      `<title>Bitwarden vault</title>`,
      `<title>FastVault vault</title>`,
    ],
    [
      "apps/browser/src/autofill/overlay/inline-menu/pages/menu-container/menu-container.html",
      `<title>Bitwarden inline menu</title>`,
      `<title>FastVault inline menu</title>`,
    ],
    [
      "apps/browser/src/platform/offscreen-document/index.html",
      `<title>Bitwarden Offscreen Document</title>`,
      `<title>FastVault Offscreen Document</title>`,
    ],
    [
      "apps/browser/src/sidepanel-disabled.html",
      `<title>Bitwarden</title>`,
      `<title>FastVault</title>`,
    ],
    [
      "apps/browser/src/autofill/browser/main-context-menu-handler.ts",
      `        title: "Bitwarden",`,
      `        title: "FastVault",`,
    ],
    [
      "apps/browser/src/dirt/phishing-detection/popup/protected-by-component.html",
      `"protectedBy" | i18n: "Bitwarden phishing blocker"`,
      `"protectedBy" | i18n: "FastVault phishing blocker"`,
    ],
    // about-dialog.component.html's title + copyright/attribution lines: owned by applyBrowser()
    // (Task 1), not here — it rewrites the same two lines with the final wording (an <small>-wrapped
    // attribution paragraph). A duplicate anchor here would already be consumed by the time
    // applyBrowser() runs (applyCode() always runs first) and fail with a false "0 matches".
  ])
    replaceExact(f, from, to);
  // Console/log lines naming the desktop app the extension talks to (comments included).
  replaceRegexMin(
    "apps/browser/src/platform/ipc/ipc-background.service.ts",
    /Bitwarden Desktop/g,
    "FastVault Desktop",
    4,
  );
  replaceRegexMin(
    "apps/browser/src/background/nativeMessaging.background.ts",
    /Bitwarden Desktop/g,
    "FastVault Desktop",
    7,
  );

  // Generic link rules across the apps and libs (counts printed; each must fire).
  // The trailing character class excludes "<" and ">" as well as quotes/backticks/parens: an
  // Angular template renders a bare URL as its own link text ("...export-your-data/</a>"), and
  // without that exclusion the greedy match swallowed the closing tag and corrupted the markup.
  const rules = [
    [/https:\/\/bitwarden\.com\/help\/?[^"'`)<>\s]*/g, `${SITE}/support`],
    [/https:\/\/bitwarden\.com\/terms\/?/g, `${SITE}/legal/terms`],
    [/https:\/\/bitwarden\.com\/privacy\/?/g, `${SITE}/legal/privacy`],
    [/https:\/\/bitwarden\.com\/download\/?[^"'`)<>\s]*/g, `${SITE}/apps`],
    [/https:\/\/bitwarden\.com\/browser-start\/?/g, `${SITE}/apps`],
    [/https:\/\/bitwarden\.com\/products\/[^"'`)<>\s]*/g, `${SITE}/`],
    [/https:\/\/bitwarden\.com\/email-preferences/g, `${SITE}/legal/privacy`],
    [/https:\/\/bitwarden\.com\/go\/[^"'`)<>\s]*/g, `${SITE}/pricing`],
    [/https:\/\/bitwarden\.com\/contact\/?/g, `${SITE}/support`],
    [/https:\/\/blog\.bitwarden\.com\/?/g, `${SITE}`],
  ];
  const fired = rules.map(() => 0);
  for (const t of REWRITE_ROOTS)
    for (const f of walk(
      t,
      (p) => /\.(ts|html)$/.test(p) && !EXCLUDED_FILES.some((re) => re.test(p)),
    )) {
      let s = read(f),
        changed = false;
      rules.forEach(([re, to], i) => {
        const n = (s.match(re) || []).length;
        if (n) {
          s = s.replace(re, to);
          fired[i] += n;
          changed = true;
        }
      });
      if (changed) write(f, s);
    }
  rules.forEach(([re], i) => {
    if (!fired[i]) fail(`link rule never fired: ${re}`);
    log(`link rule ${re} fired ${fired[i]}x`);
  });

  // Theme (spec §4.6) — brand scale once, primary/background per theme block
  const css = "libs/components/src/tw-theme.css";
  const brand = {
    "050": ["#eef6ff", "#EEF5F2"],
    100: ["#dbeafe", "#DCEFE7"],
    200: ["#bedbff", "#B7E3D2"],
    300: ["#8ec5ff", "#86D6B8"],
    400: ["#6baefa", "#55CBA1"],
    500: ["#418bfb", "#2BBE8B"],
    600: ["#2a70f4", "#22A879"],
    700: ["#175ddc", "#0B6E52"],
    800: ["#0d43af", "#0A5A44"],
    900: ["#0c3276", "#0D3F33"],
    950: ["#162455", "#08201C"],
  };
  for (const [k, [o, n]] of Object.entries(brand))
    replaceExact(css, `--color-brand-${k}: ${o};`, `--color-brand-${k}: ${n};`);
  replaceExact(css, `--color-brand-950-rgb: 22, 36, 85;`, `--color-brand-950-rgb: 8, 32, 28;`);
  const triplets = [
    ["--color-primary-100: 219 229 246;", "--color-primary-100: 220 239 231;"],
    ["--color-primary-300: 121 161 233;", "--color-primary-300: 134 214 184;"],
    ["--color-primary-600: 23 93 220;", "--color-primary-600: 11 110 82;"],
    ["--color-primary-700: 26 65 172;", "--color-primary-700: 10 90 68;"],
    ["--color-background-alt2: 23 92 219;", "--color-background-alt2: 11 110 82;"],
    ["--color-background-alt3: 22 55 146;", "--color-background-alt3: 13 63 51;"],
    ["--color-background-alt4: 2 15 102;", "--color-background-alt4: 8 32 28;"],
    ["--color-primary-100: 29 46 99;", "--color-primary-100: 13 63 51;"],
    ["--color-primary-300: 26 65 172;", "--color-primary-300: 11 110 82;"],
    ["--color-primary-600: 101 171 255;", "--color-primary-600: 43 190 139;"],
    ["--color-primary-700: 170 195 239;", "--color-primary-700: 134 214 184;"],
  ];
  for (const [o, n] of triplets) replaceExact(css, o, n);
}

// ---------- 4b. browser ----------
function applyBrowser() {
  const G = "branding/generated/browser";
  for (const s of [16, 19, 32, 38, 48, 96, 128]) {
    copy(`${G}/icon${s}.png`, `apps/browser/src/images/icon${s}.png`);
    copy(`${G}/icon${s}_gray.png`, `apps/browser/src/images/icon${s}_gray.png`);
  }
  for (const s of [19, 38])
    copy(`${G}/icon${s}_locked.png`, `apps/browser/src/images/icon${s}_locked.png`);
  copy(
    "branding/generated/desktop/logo-dark@2x.png",
    "apps/browser/src/popup/images/logo-dark@2x.png",
  );
  copy(
    "branding/generated/desktop/logo-white@2x.png",
    "apps/browser/src/popup/images/logo-white@2x.png",
  );
  for (const f of ["chrome-icon128.png", "icon64.png", "windows-icon300.png"])
    copy(`${G}/store/${f}`, `apps/browser/store/icons/${f}`);

  // Popup document <title> (webpack's HtmlWebpackPlugin renders this .ejs template into
  // popup/index.html). REWRITE_ROOTS' walk only visits .ts/.html, so this .ejs file — the only one
  // in scope — is invisible to both applyCode()'s generic title sweep and verify()'s residual scan;
  // found live in the built popup/index.html via the post-build "Bitwarden" grep. Same fix as the
  // other extension-surface <title> tags a few lines below, just anchored here since walk() can't
  // reach it.
  replaceExact(
    "apps/browser/src/popup/index.ejs",
    `<title>Bitwarden</title>`,
    `<title>FastVault</title>`,
  );

  // Inline autofill menu logo (injected into web pages)
  const icons = "apps/browser/src/autofill/utils/svg-icons.ts";
  const ours = readFileSync(join(FV, "branding/inline-menu-icons.ts"), "utf8").trim();
  const s = read(icons);
  const re =
    /export const logoIcon =\n\s+'<svg[^\n]*';\n\nexport const logoLockedIcon =\n\s+'<svg[^\n]*';/g;
  const iconMatches = s.match(re)?.length ?? 0;
  if (iconMatches !== 1)
    fail(`${icons}: expected 1 logoIcon/logoLockedIcon block, found ${iconMatches}`);
  write(icons, s.replace(re, ours));
  log(`${icons}: inline-menu logos replaced`);

  // About dialog + About page + settings trims
  const dlg = "apps/browser/src/tools/popup/settings/about-dialog/about-dialog.component.html";
  replaceExact(dlg, `<div bitDialogTitle>Bitwarden</div>`, `<div bitDialogTitle>FastVault</div>`);
  replaceExact(
    dlg,
    `<p>&copy; Bitwarden Inc. 2015-{{ year }}</p>`,
    `<p>&copy; FSITES LTD {{ year }}</p>\n    <p><small>{{ "fastvaultAttribution" | i18n }}</small></p>`,
  );
  const about = "apps/browser/src/tools/popup/settings/about-page/about-page-v2.component.html";
  removeElement(about, `(click)="rate()"`); // the "Rate extension" item
  const settings = "apps/browser/src/tools/popup/settings/settings-v2.component.html";
  removeElement(settings, `routerLink="/download-bitwarden"`);
  removeElement(settings, `routerLink="/more-from-bitwarden"`);

  // The two menu entries above pointed at these routes; with no way to reach them from the UI,
  // drop the routes (and their now-unused imports) too, or the pages — still Bitwarden-branded —
  // stay reachable by direct navigation (e.g. a saved deep link) even with the menu gone.
  const routing = "apps/browser/src/popup/app-routing.module.ts";
  replaceExact(
    routing,
    `  {
    path: "more-from-bitwarden",
    component: MoreFromBitwardenPageComponent,
    canActivate: [authGuard],
    data: { elevation: 2 } satisfies RouteDataProperties,
  },
`,
    "",
  );
  replaceExact(
    routing,
    `  {
    path: "download-bitwarden",
    component: DownloadBitwardenComponent,
    canActivate: [authGuard],
    data: { elevation: 2 } satisfies RouteDataProperties,
  },
`,
    "",
  );
  replaceExact(
    routing,
    `import { DownloadBitwardenComponent } from "../vault/popup/settings/download-bitwarden.component";
`,
    "",
  );
  replaceExact(
    routing,
    `import { MoreFromBitwardenPageComponent } from "../vault/popup/settings/more-from-bitwarden-page.component";
`,
    "",
  );

  // Desktop bridge host name (2 call sites)
  for (const f of [
    "apps/browser/src/background/nativeMessaging.background.ts",
    "apps/browser/src/platform/ipc/ipc-background.service.ts",
  ])
    replaceExact(
      f,
      `connectNative("com.8bit.bitwarden")`,
      `connectNative("app.fastvault.desktop")`,
    );

  // Manifest fields verify() cannot see (JSON, not .ts/.html): the toolbar/sidebar tooltip text
  // and the extension author, both shown directly in the browser chrome (toolbar hover, sidebar
  // hover, extension-management page) — found via the post-build "Bitwarden" grep, not anchored
  // by anything upstream of this task. applyConfig() already rewrites short_name/version/
  // homepage_url/gecko.id on these same two files; this is the rest of that file's visible
  // branding, kept here since it is specific to the browser overlay.
  editJson("apps/browser/src/manifest.json", (j) => {
    if (j.author !== "Bitwarden Inc.")
      fail(`manifest.json: unexpected author ${JSON.stringify(j.author)}`);
    j.author = "FSITES LTD";
    if (j.browser_action?.default_title !== "Bitwarden")
      fail(
        `manifest.json: unexpected browser_action.default_title ${JSON.stringify(j.browser_action?.default_title)}`,
      );
    j.browser_action.default_title = "FastVault";
    for (const k of ["__firefox__sidebar_action", "__opera__sidebar_action"]) {
      if (j[k]?.default_title !== "Bitwarden")
        fail(`manifest.json: unexpected ${k}.default_title ${JSON.stringify(j[k]?.default_title)}`);
      j[k].default_title = "FastVault";
    }
  });
  editJson("apps/browser/src/manifest.v3.json", (j) => {
    if (j.author !== "Bitwarden Inc.")
      fail(`manifest.v3.json: unexpected author ${JSON.stringify(j.author)}`);
    j.author = "FSITES LTD";
    if (j.action?.default_title !== "Bitwarden")
      fail(
        `manifest.v3.json: unexpected action.default_title ${JSON.stringify(j.action?.default_title)}`,
      );
    j.action.default_title = "FastVault";
    for (const k of ["__firefox__sidebar_action", "__opera__sidebar_action"]) {
      if (j[k]?.default_title !== "Bitwarden")
        fail(
          `manifest.v3.json: unexpected ${k}.default_title ${JSON.stringify(j[k]?.default_title)}`,
        );
      j[k].default_title = "FastVault";
    }
  });

  // Dev-only stable Chrome id (never shipped to stores): FV_DEV=1 node fastvault/apply.mjs
  // dev-chrome-key.txt is generated by Task 2 Step 1 and is not committed; fail with a clear
  // message rather than an ENOENT stack trace when someone sets FV_DEV=1 before that exists.
  if (process.env.FV_DEV === "1") {
    const keyFile = join(FV, "dev-chrome-key.txt");
    if (!existsSync(keyFile))
      fail(
        `FV_DEV=1 is set but ${rel(keyFile)} does not exist — generate it first (see Task 2 Step 1), or run without FV_DEV=1.`,
      );
    const key = readFileSync(keyFile, "utf8").trim(); // base64 public key, see Task 2 Step 1
    for (const m of ["apps/browser/src/manifest.json", "apps/browser/src/manifest.v3.json"])
      editJson(m, (j) => {
        j.key = key;
      });
  }
}

// ---------- 5. verify ----------
const ALLOWED_BRAND_KEYS = new Set(["fastvaultAttribution", "getMobileApp"]);
// Exact-string opt-outs for the code literal-string check below: never-displayed internal
// identifiers that still contain "Bitwarden" as a substring. Each would need a change outside
// this task's scope to fix correctly (not a simple anchored rename), and none leak the brand to
// a user:
const ALLOWED_LITERAL_STRINGS = new Set([
  // Angular template binding to the shield SVG's exported symbol name. The icon's own content
  // is already FastVault-branded (Task 3's applyAssets()); renaming the TS export itself would
  // require also editing libs/components/src/navigation/nav-logo.component.ts, which is outside
  // this task's file scope.
  `"Icons.BitwardenShield"`,
  // i18n lookup keys — not the displayed message text (applyStrings() already renamed every
  // .message value). Renaming the key itself means renaming it in all 66 locale files plus every
  // this.localize(key) / { key: ... } call site; a different class of change than an anchored
  // literal-string replace.
  `"closeThisBitwardenWindow"`,
  `"aboutBitwarden"`,
  `"hideBitwarden"`,
  `"quitBitwarden"`,
  // Detects Bitwarden's own registered Microsoft Store package family name, not FastVault's —
  // and is dead code for FastVault regardless, since applyConfig() already drops "appx" from
  // electron-builder.json's win.target, so FastVault never produces an MSIX/Store build this
  // check could match.
  `"8bitSolutionsLLC.BitwardenBeta_"`,
  // HTTP header names the SERVER reads (libs/common/src/services/api.service.ts). These are
  // wire-protocol identifiers, not brand text: Vaultwarden/Bitwarden Server parse them by exact
  // name, so renaming them breaks every request the app makes.
  `"Bitwarden-Client-Name"`,
  `"Bitwarden-Client-Version"`,
  `"Bitwarden-Package-Type"`,
]);
// Pattern opt-outs for the same check. These cover mechanical CLASSES of internal identifier that
// would otherwise need dozens of near-identical exact entries; each is deliberately narrow enough
// that a real display string cannot match it (all three require a lowercase camelCase head, which
// a user-facing sentence or a bare "Bitwarden" never has).
const ALLOWED_LITERAL_PATTERNS = [
  // camelCase i18n lookup KEYS ("aboutBitwarden", "continueToBitwardenDotCom", "newToBitwarden",
  // "saveToBitwarden", ...) and Angular template handler names ("openFreeBitwardenFamiliesPage()").
  // The displayed .message value behind every one of these keys is already renamed by
  // applyStrings(); renaming the key itself means touching all 66 locale files plus every call
  // site, a different class of change than an anchored literal replace.
  /^"[a-z][A-Za-z0-9]*Bitwarden[A-Za-z0-9]*(\(\))?"$/,
  // ...the same keys inside an Angular template expression bound to an attribute:
  //   title="{{ 'downloadBitwarden' | i18n }}"   [appA11yTitle]="'updateInBitwarden' | i18n"
  /^"\{\{ ?'[a-z][A-Za-z0-9]*Bitwarden[A-Za-z0-9]*' ?\| ?i18n ?\}\}"$/,
  /^"'[a-z][A-Za-z0-9]*Bitwarden[A-Za-z0-9]*' ?\| ?i18n"$/,
];
const URL_RE = /https?:\/\/(?!contributing\.)[a-z0-9.-]*bitwarden\.(com|eu|net)[^\s"'`)<>]*/g;
function verify() {
  const problems = [];
  for (const { dir } of LOCALE_DIRS) {
    const j = JSON.parse(read(`${dir}/en/messages.json`));
    for (const [k, v] of Object.entries(j)) {
      if (v?.message?.includes("Bitwarden") && !ALLOWED_BRAND_KEYS.has(k))
        problems.push(`${dir}/en: key ${k} still says Bitwarden`);
      // Same residual check for the lowercase domain reference applyStrings() now also renames
      // (e.g. "...set up on the bitwarden.com web vault.") — a different substitution than the
      // brand-name rename above, so it needs its own leftover check.
      if (v?.message?.includes("bitwarden.com"))
        problems.push(`${dir}/en: key ${k} still says bitwarden.com`);
    }
  }
  // One scan over exactly the files applyCode()'s sweep rewrote — same roots, same exclusions.
  let scanned = 0;
  for (const t of REWRITE_ROOTS)
    for (const f of walk(
      t,
      (p) => /\.(ts|html)$/.test(p) && !EXCLUDED_FILES.some((re) => re.test(p)),
    )) {
      scanned++;
      const s = read(f);
      // a. residual bitwarden.com / .eu / .net URLs
      for (const m of s.matchAll(URL_RE)) problems.push(`${f}: url ${m[0]}`);
      // b. residual "…Bitwarden…" string literals
      for (const m of s.matchAll(/"[^"\n]*Bitwarden[^"\n]*"/g))
        if (
          !ALLOWED_LITERAL_STRINGS.has(m[0]) &&
          !ALLOWED_LITERAL_PATTERNS.some((re) => re.test(m[0]))
        )
          problems.push(`${f}: literal ${m[0]}`);
      // b2. ...and template literals. Missing these is how the flight recorder kept writing
      //     `Bitwarden-diagnostic-report-<date>.csv` through two releases. Interpolations and
      //     nested quoted spans are blanked first: check (b) already owns anything quoted, and an
      //     expression like `${t("saveToBitwarden")}` is an i18n key, not display text.
      for (const m of s.matchAll(/`[^`\n]*Bitwarden[^`\n]*`/g)) {
        const bare = m[0].replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
        if (bare.includes("Bitwarden")) problems.push(`${f}: template literal ${m[0]}`);
      }
      // c. residual brand text in HTML *body* content — <title>Bitwarden</title>, "© Bitwarden
      //    Inc.", "upload the file here to Bitwarden." None of those sit inside a quoted string,
      //    so check (b) cannot see them. Quoted attribute values and Angular expressions are
      //    blanked first so (b) stays the single owner of that class; the single-quote pattern is
      //    deliberately restricted to identifier-shaped spans so an apostrophe in prose cannot
      //    swallow a real mention.
      if (f.endsWith(".html") && !ALLOWED_HTML_TEXT_FILES.some((re) => re.test(f))) {
        const text = s
          .replace(/"[^"\n]*"/g, '""')
          .replace(/'[A-Za-z0-9_.\- ]*'/g, "''")
          // Angular interpolations and control-flow conditions are code, not body text: their
          // displayed value comes from the locale files (check (a) on LOCALE_DIRS owns those) and
          // their identifiers (showDownloadBitwardenNudge$) are component properties.
          .replace(/\{\{[^}]*\}\}/g, "")
          .replace(/@[a-z]+ ?\([^)]*\)/g, "");
        for (const line of text.split("\n"))
          if (line.includes("Bitwarden")) problems.push(`${f}: html text ${line.trim()}`);
      }
    }
  // Linux packaging files live outside REWRITE_ROOTS; check the four the overlay rewrites explicitly.
  // after-pack.js is narrowed to /bitwarden-app/ instead of the general /bitwarden/i: its darwin-only
  // signing branch names Bitwarden's own Apple codesigning identities ("Developer ID Application:
  // Bitwarden Inc", "3rd Party Mac Developer Application: Bitwarden Inc") plus a comment referencing
  // them — real Apple-registered certificate common names, out of scope (FastVault has no Bitwarden
  // Inc certificate to sign with regardless).
  // linux-wrapper.sh keeps the general /bitwarden/i check, but with one specific KNOWN LINE stripped
  // first — not the whole file narrowed to /bitwarden-app/ the way after-pack.js is. That line is an
  // inert comment linking Bitwarden's own private Jira (an Electron/Wayland upstream-bug tracking
  // note), not user-facing text and not FastVault's ticket to rewrite. Narrowing by exact line (like
  // EXCLUDED_FILES/ALLOWED_HTML_TEXT_FILES narrow by whole file, one level finer) means any OTHER
  // "bitwarden" mention added to this file later — a new comment, a new string, anything unrelated to
  // this one Jira URL — still trips the check; a whole-file exemption would have silently missed it.
  const LINUX_WRAPPER_JIRA_COMMENT =
    "  # fixed. The follow-up task is https://bitwarden.atlassian.net/browse/PM-31080.";
  for (const f of [
    "apps/desktop/scripts/after-pack.js",
    "apps/desktop/resources/linux-wrapper.sh",
    "apps/desktop/resources/com.bitwarden.desktop.desktop",
    "apps/desktop/resources/com.bitwarden.desktop.policy",
  ]) {
    let content = read(f);
    if (f.endsWith("linux-wrapper.sh")) {
      // Anchored like every other rule in this file: if upstream ever changes or removes this exact
      // comment, report it as a problem (below, with everything else verify() finds) instead of
      // leaving a stale, silently-inert exception in place. Pushed onto `problems` rather than a
      // bare fail() so a developer sees this alongside every other residual-brand finding in one
      // run, the same pattern every other check in verify() follows.
      if (!content.includes(LINUX_WRAPPER_JIRA_COMMENT))
        problems.push(
          `${f}: expected Jira-comment line not found — update LINUX_WRAPPER_JIRA_COMMENT`,
        );
      else content = content.replace(LINUX_WRAPPER_JIRA_COMMENT, "");
    }
    const re = f.endsWith("after-pack.js") ? /bitwarden-app/i : /bitwarden/i;
    if (re.test(content)) problems.push(`${f}: still mentions bitwarden`);
  }
  // The IPC name must be the same on both sides, or the browser's proxy can never find the app:
  // the desktop app listens on it (TS), the proxy connects to it (Rust). Checked here rather than
  // trusted, because the two anchors live in two languages and either could drift on a rebase.
  const IPC_NAME = `"fastvault"`;
  if (
    !read("apps/desktop/src/main/native-messaging.main.ts").includes(
      `NativeIpcServer.listen(${IPC_NAME}, `,
    )
  )
    problems.push(`native-messaging.main.ts: desktop app does not listen on ${IPC_NAME}`);
  const proxySrc = read("apps/desktop/desktop_native/proxy/src/main.rs");
  if (!proxySrc.includes(`all_paths(${IPC_NAME})`))
    problems.push(`proxy/src/main.rs: proxy does not connect to ${IPC_NAME}`);
  if (/bitwarden/i.test(proxySrc)) problems.push(`proxy/src/main.rs: still mentions bitwarden`);
  // Backstop for the two browser-extension file kinds the .ts/.html walk above cannot see:
  // popup/index.ejs (an .ejs template) and the two manifest .json files. Task 1's fix rounds found
  // real "Bitwarden" leaks in exactly these files, invisible to REWRITE_ROOTS' `/\.(ts|html)$/`
  // filter — this makes a future regression here fail loudly instead of shipping silently.
  if (read("apps/browser/src/popup/index.ejs").includes("Bitwarden"))
    problems.push(`apps/browser/src/popup/index.ejs: still mentions Bitwarden`);
  for (const [m, actionKey] of [
    ["apps/browser/src/manifest.json", "browser_action"],
    ["apps/browser/src/manifest.v3.json", "action"],
  ]) {
    const j = JSON.parse(read(m));
    for (const k of ["name", "short_name", "author", "description"])
      if (typeof j[k] === "string" && j[k].includes("Bitwarden"))
        problems.push(`${m}: ${k} still says Bitwarden (${JSON.stringify(j[k])})`);
    if (
      typeof j[actionKey]?.default_title === "string" &&
      j[actionKey].default_title.includes("Bitwarden")
    )
      problems.push(
        `${m}: ${actionKey}.default_title still says Bitwarden (${JSON.stringify(j[actionKey].default_title)})`,
      );
  }
  if (problems.length) {
    for (const p of problems) console.error("  -", p);
    fail(`${problems.length} residual brand reference(s)`);
  }
  log(`verify: clean (${scanned} files across ${REWRITE_ROOTS.join(", ")})`);
}

// ---------- main ----------
// Guarded so fastvault/verify-build.mjs can import the allow-lists below without running the
// overlay as a side effect of the import. `node fastvault/apply.mjs` still behaves exactly as
// before; anything that merely imports this module gets the constants and nothing else.
export { ALLOWED_BRAND_KEYS, ALLOWED_LITERAL_STRINGS, ALLOWED_LITERAL_PATTERNS };
if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  applyAssets();
  applyStrings();
  applyConfig();
  applyCode();
  applyBrowser();
  verify();
  log(DRY ? "dry run complete" : `applied FastVault ${VERSION} overlay`);
}

#!/usr/bin/env node
// FastVault overlay. Rewrites an upstream bitwarden/clients checkout into FastVault.
// Run from the repo root of a CLEAN checkout (CI, or the throwaway build worktree):
//   node fastvault/apply.mjs            apply + verify
//   node fastvault/apply.mjs --dry      report what would change, write nothing
// Every replacement is anchored: wrong match count => exit 1 (upstream drift; fix here, never in the tree).
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

const log = (...a) => console.log("[fastvault]", ...a);
const fail = (msg) => {
  console.error("[fastvault] FAIL:", msg);
  process.exit(1);
};
const rel = (p) => p.replace(ROOT + "\\", "").replace(ROOT + "/", "");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const write = (p, s) => {
  if (!DRY) writeFileSync(join(ROOT, p), s);
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
function applyStrings() {
  const drop = JSON.parse(readFileSync(join(FV, "strings/drop-from-other-locales.json"), "utf8"));
  for (const { app, dir } of LOCALE_DIRS) {
    const overrides = JSON.parse(
      readFileSync(join(FV, `strings/overrides.${app}.en.json`), "utf8"),
    );
    let files = 0,
      hits = 0;
    for (const loc of readdirSync(join(ROOT, dir))) {
      const file = `${dir}/${loc}/messages.json`;
      if (!existsSync(join(ROOT, file))) continue;
      const j = JSON.parse(read(file));
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v.message === "string" && v.message.includes("Bitwarden")) {
          v.message = v.message.split("Bitwarden").join("FastVault");
          hits++;
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
      `${app}: ${files} locale files, ${hits} brand mentions renamed, ${Object.keys(overrides).length} overrides`,
    );
  }
  // Store listing texts (plan B uses them; renaming now is harmless and keeps one rule)
  const storeDir = "apps/browser/store/locales";
  let n = 0;
  for (const f of walk(storeDir, (p) => p.endsWith(".json"))) {
    const s = read(f);
    if (s.includes("Bitwarden")) {
      write(f, s.split("Bitwarden").join("FastVault"));
      n++;
    }
  }
  log(`store locales: ${n} files renamed`);
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
    const azure =
      process.env.AZURE_SIGN_ENDPOINT &&
      process.env.AZURE_SIGN_ACCOUNT &&
      process.env.AZURE_SIGN_PROFILE;
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

  // Generic link rules across the apps and libs (counts printed; each must fire)
  const rules = [
    [/https:\/\/bitwarden\.com\/help\/?[^"'`)\s]*/g, `${SITE}/support`],
    [/https:\/\/bitwarden\.com\/terms\/?/g, `${SITE}/legal/terms`],
    [/https:\/\/bitwarden\.com\/privacy\/?/g, `${SITE}/legal/privacy`],
    [/https:\/\/bitwarden\.com\/download\/?[^"'`)\s]*/g, `${SITE}/apps`],
    [/https:\/\/bitwarden\.com\/browser-start\/?/g, `${SITE}/apps`],
    [/https:\/\/bitwarden\.com\/products\/[^"'`)\s]*/g, `${SITE}/`],
    [/https:\/\/bitwarden\.com\/email-preferences/g, `${SITE}/legal/privacy`],
    [/https:\/\/bitwarden\.com\/go\/[^"'`)\s]*/g, `${SITE}/pricing`],
    [/https:\/\/bitwarden\.com\/contact\/?/g, `${SITE}/support`],
    [/https:\/\/blog\.bitwarden\.com\/?/g, `${SITE}`],
  ];
  const targets = [
    "apps/desktop/src",
    "apps/browser/src",
    "libs/auth/src",
    "libs/angular/src",
    "libs/vault/src",
    "libs/components/src",
    "libs/key-management",
  ];
  const fired = rules.map(() => 0);
  for (const t of targets)
    for (const f of walk(t, (p) => /\.(ts|html)$/.test(p) && !/\.(spec|stories)\.ts$/.test(p))) {
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

// ---------- 5. verify ----------
const ALLOWED_BRAND_KEYS = new Set(["fastvaultAttribution", "getMobileApp"]);
const ALLOWED_URL_FILES = [
  /\.spec\.ts$/,
  /\.stories\.ts$/,
  /phishing-resources\.ts$/,
  /lastpass-direct-import\.service\.ts$/,
  /\/importers\//,
];
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
]);
function verify() {
  const problems = [];
  for (const { dir } of LOCALE_DIRS) {
    const j = JSON.parse(read(`${dir}/en/messages.json`));
    for (const [k, v] of Object.entries(j))
      if (v?.message?.includes("Bitwarden") && !ALLOWED_BRAND_KEYS.has(k))
        problems.push(`${dir}/en: key ${k} still says Bitwarden`);
  }
  for (const f of walk("apps/desktop/src", (p) => /\.(ts|html)$/.test(p))) {
    if (ALLOWED_URL_FILES.some((re) => re.test(f))) continue;
    const s = read(f);
    for (const m of s.matchAll(/https?:\/\/[a-z0-9.-]*bitwarden\.(com|eu|net)[^\s"'`)]*/g))
      problems.push(`${f}: ${m[0]}`);
    for (const m of s.matchAll(/"[^"\n]*Bitwarden[^"\n]*"/g))
      if (!ALLOWED_LITERAL_STRINGS.has(m[0])) problems.push(`${f}: literal ${m[0]}`);
  }
  for (const f of [
    "libs/auth",
    "libs/angular",
    "libs/vault",
    "libs/components",
    "libs/common/src/platform/services",
  ]) {
    for (const g of walk(f, (p) => /\.(ts|html)$/.test(p))) {
      if (ALLOWED_URL_FILES.some((re) => re.test(g))) continue;
      for (const m of read(g).matchAll(
        /https?:\/\/(?!contributing\.)[a-z0-9.-]*bitwarden\.(com|eu|net)[^\s"'`)]*/g,
      ))
        problems.push(`${g}: ${m[0]}`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error("  -", p);
    fail(`${problems.length} residual brand reference(s)`);
  }
  log("verify: clean");
}

// ---------- main ----------
applyAssets();
applyStrings();
applyConfig();
applyCode();
verify();
log(DRY ? "dry run complete" : `applied FastVault ${VERSION} overlay`);

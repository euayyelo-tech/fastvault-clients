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

// ---------- 5. verify ----------
const ALLOWED_BRAND_KEYS = new Set(["fastvaultAttribution", "getMobileApp"]);
const ALLOWED_URL_FILES = [
  /\.spec\.ts$/,
  /\.stories\.ts$/,
  /phishing-resources\.ts$/,
  /lastpass-direct-import\.service\.ts$/,
  /\/importers\//,
];
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
    if (/"Bitwarden"/.test(s)) problems.push(`${f}: literal "Bitwarden"`);
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
if (typeof applyConfig === "function") applyConfig(); // Task 4
if (typeof applyCode === "function") applyCode(); // Task 4
verify();
log(DRY ? "dry run complete" : `applied FastVault ${VERSION} overlay`);

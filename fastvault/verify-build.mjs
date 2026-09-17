#!/usr/bin/env node
// FastVault post-build brand check (design spec §4.8).
//
// apply.mjs's verify() proves the SOURCE TREE is rebranded. This proves the thing users actually
// install is: it reads apps/desktop/build — the webpack output electron-builder packages — and
// fails if any user-reachable "Bitwarden" survived. Run it after `npm run build` and before
// electron-builder, so a brand regression costs one build step instead of a published release.
//
//   node fastvault/verify-build.mjs [buildDir]     (default apps/desktop/build)
//
// What it checks, and why only this:
//   * locales/<lang>/messages.json — the app's whole user-visible string table. Every .message
//     value, in all 66 languages, not just en. Keys are ignored (they are lookup identifiers;
//     apply.mjs documents that class) except the ones in ALLOWED_BRAND_KEYS.
//   * package.json — the manifest that ships inside the app (author/description/productName/...).
//   * index.html + .css — small enough to check whole.
//   * .js bundles — STRING AND TEMPLATE LITERALS only. A bundle also contains comments, symbol
//     names and third-party SDK doc-blocks with "Bitwarden" in them; none of those can reach a
//     screen, and no allow-list of them would stay true across an upstream bump. Text inside a
//     quote is the part that can be displayed, so that is what is enforced.
// Deliberately skipped: *.map (source maps — third-party library sources plus a copy of the .js
// already checked; never rendered) and *.wasm (binary @bitwarden/sdk-internal build artefact).
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALLOWED_BRAND_KEYS, ALLOWED_LITERAL_STRINGS } from "./apply.mjs";

const BUILD = resolve(process.argv[2] ?? "apps/desktop/build");
const BRAND = "Bitwarden";
const problems = [];
const log = (...a) => console.log("[fastvault:build]", ...a);

// apply.mjs's source-level opt-outs, reused here as substrings: the minifier rewrites the code
// around them but never the contents of a string literal, so "Bitwarden-Client-Name" and
// "8bitSolutionsLLC.BitwardenBeta_" survive verbatim into the bundle. Each one's justification
// lives next to the entry in apply.mjs; this file does not restate them.
const ALLOWED_SUBSTRINGS = [...ALLOWED_LITERAL_STRINGS].map((s) => s.replace(/^"|"$/g, ""));
// Opt-outs that only exist once the code is bundled.
const BUILD_ALLOWED_PATTERNS = [
  // libs/components anon-layout's "© <year> Bitwarden Inc." footer, and the GPL/trademark
  // attribution FastVault itself shows (fastvaultAttribution, and the About dialog's
  // "Based on the Bitwarden clients © 2015-2026 Bitwarden Inc." copyright line). Naming the
  // trademark holder in an attribution line is required by the licence, not a branding leak.
  // The anon-layout one is additionally never rendered: anon-layout.component.ts's
  // hideYearAndVersion is true for every client this repo builds. Confirmed inert 2026-09-17.
  /Bitwarden Inc\./,
  // "…based on the open-source Bitwarden® clients (GPL-3.0)…" / "compatible with the official
  // Bitwarden apps" — deliberate nominative use, same reason as above.
  /Bitwarden®|official Bitwarden apps/,
];

const allowed = (ctx) =>
  ALLOWED_SUBSTRINGS.some((x) => ctx.includes(x)) ||
  BUILD_ALLOWED_PATTERNS.some((re) => re.test(ctx));

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const relative = (p) => p.slice(BUILD.length + 1).replace(/\\/g, "/");

// --- locale string tables -------------------------------------------------
function checkLocales() {
  const dir = join(BUILD, "locales");
  if (!existsSync(dir)) return fail("no locales/ directory in the build output");
  let langs = 0,
    keys = 0;
  for (const lang of readdirSync(dir)) {
    const f = join(dir, lang, "messages.json");
    if (!existsSync(f)) continue;
    langs++;
    const j = JSON.parse(readFileSync(f, "utf8"));
    for (const [k, v] of Object.entries(j)) {
      keys++;
      if (typeof v?.message === "string" && v.message.includes(BRAND) && !ALLOWED_BRAND_KEYS.has(k))
        problems.push(`locales/${lang}/messages.json: ${k} = ${JSON.stringify(v.message)}`);
    }
  }
  if (langs < 50) problems.push(`locales/: only ${langs} languages found — did the layout change?`);
  log(`locales: ${langs} languages, ${keys} messages checked`);
}

// --- everything else ------------------------------------------------------
const IDENT = /[A-Za-z0-9_$]/;
// Grow an occurrence out to the whole identifier token it sits in: "aboutBitwarden",
// "BitwardenShield", "DownloadBitwarden". A token longer than the brand itself is a symbol name or
// an i18n lookup key, never displayed text — the text behind every key is checked directly, in the
// locale tables above. A bare "Bitwarden" is a word in prose and has to be explained.
function token(s, i) {
  let a = i,
    b = i + BRAND.length;
  while (a > 0 && IDENT.test(s[a - 1])) a--;
  while (b < s.length && IDENT.test(s[b])) b++;
  return s.slice(a, b);
}
const lineOf = (s, i) => {
  const a = s.lastIndexOf("\n", i) + 1;
  const b = s.indexOf("\n", i);
  return s.slice(a, b < 0 ? s.length : b);
};
const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line) && line.length < 2000;

function checkFiles() {
  let files = 0,
    occurrences = 0;
  for (const p of walk(BUILD)) {
    const r = relative(p);
    if (r.startsWith("locales/")) continue; // handled above
    if (/\.(map|wasm|png|ico|jpg|jpeg|gif|svg|woff2?|ttf|eot|node|exe|dll)$/i.test(r)) continue;
    if (statSync(p).size > 64 * 1024 * 1024) {
      problems.push(`${r}: too large to scan`);
      continue;
    }
    files++;
    const s = readFileSync(p, "utf8");
    let i = -1;
    while ((i = s.indexOf(BRAND, i + 1)) >= 0) {
      occurrences++;
      if (r.endsWith(".js")) {
        if (token(s, i) !== BRAND) continue; // part of a longer identifier
        const line = lineOf(s, i);
        if (isComment(line)) continue; // a comment cannot reach a screen
      }
      // Everything else — prose in a bundle, and every occurrence in html/css/json/txt — has to
      // match a documented allow-list entry or the build fails.
      const ctx = s.slice(Math.max(0, i - 70), i + 70).replace(/\s+/g, " ");
      const line = lineOf(s, i).trim();
      if (allowed(ctx) || allowed(line)) continue;
      problems.push(`${r}: ${ctx}`);
    }
  }
  log(`scanned ${files} files, ${occurrences} "${BRAND}" occurrence(s)`);
}

function fail(msg) {
  console.error("[fastvault:build] FAIL:", msg);
  process.exit(1);
}

if (!existsSync(BUILD)) fail(`build output not found: ${BUILD} (run \`npm run build\` first)`);
checkLocales();
checkFiles();
if (problems.length) {
  for (const p of problems) console.error("  -", p);
  fail(`${problems.length} unexpected "${BRAND}" reference(s) in the built app`);
}
log("build output: clean");

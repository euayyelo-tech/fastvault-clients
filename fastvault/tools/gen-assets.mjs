// One-off generator. Run: cd fastvault/tools && npm run gen
// Outputs are committed under fastvault/branding/generated so apply.mjs needs no image library.
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../branding/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = new URL("../branding/generated/", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const INK = "#08201C",
  MINT = "#2BBE8B",
  GREY = "#8A9793",
  WHITE = "#FFFFFF";

const svg = (name) => readFileSync(join(SRC, name), "utf8");
const recolor = (s, map) =>
  Object.entries(map).reduce((acc, [from, to]) => acc.split(from).join(to), s);
const ensure = (p) => mkdirSync(p, { recursive: true });
async function png(svgText, size, out, { width, height } = {}) {
  ensure(join(OUT, out, ".."));
  const img = sharp(Buffer.from(svgText), { density: 384 });
  const resized =
    width || height
      ? img.resize({ width, height, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      : img.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  await resized.png().toFile(join(OUT, out));
}

// Padlock badge appended inside the mark's viewBox (10 12 86 96): bottom-right corner.
const LOCK_BADGE = `<g transform="translate(64 74)"><rect x="0" y="12" width="28" height="22" rx="4" fill="${INK}"/><path d="M6 12 V8 a8 8 0 0 1 16 0 V12" fill="none" stroke="${INK}" stroke-width="5"/><circle cx="14" cy="23" r="3" fill="${WHITE}"/></g>`;
const withLock = (s) => s.replace(/<\/svg>\s*$/, `${LOCK_BADGE}</svg>`);

const mark = svg("mark.svg");
const markInk = svg("mark-mono-ink.svg");
const markWhite = svg("mark-mono-white.svg");
const markGrey = recolor(markInk, { [INK]: GREY });
const lockup = svg("lockup.svg");
const lockupWhite = svg("lockup-mono-white.svg");
const appIcon = svg("app-icon.svg"); // 512x512 with the ink background, for the OS icon

// --- desktop app icon (OS): resources/icons + resources/icon.png + src/images/icon.png + .ico
for (const s of [16, 32, 64, 128, 256, 512, 1024])
  await png(appIcon, s, `desktop/icons/${s}x${s}.png`);
await png(appIcon, 1024, "desktop/icon-1024.png");
await png(appIcon, 512, "desktop/icon-512.png");
// 48px isn't part of the committed icon set; render it in-memory just for the .ico container.
const ico48 = await sharp(Buffer.from(appIcon), { density: 384 })
  .resize(48, 48, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const icoBuf = await pngToIco([
  ...[16, 32].map((s) => readFileSync(join(OUT, `desktop/icons/${s}x${s}.png`))),
  ico48,
  ...[64, 128, 256].map((s) => readFileSync(join(OUT, `desktop/icons/${s}x${s}.png`))),
]);
writeFileSync(join(OUT, "desktop/icon.ico"), icoBuf);
// --- desktop tray (mono; Windows uses icon.ico, mac uses template, linux uses icon.png)
await png(markInk, 16, "desktop/icon-template.png");
await png(markInk, 32, "desktop/icon-template@2x.png");
await png(markWhite, 16, "desktop/icon-highlight.png");
await png(markWhite, 32, "desktop/icon-highlight@2x.png");
// --- desktop + browser popup wordmarks (height 86 like upstream's 568x86)
await png(lockup, 0, "desktop/logo-dark@2x.png", { height: 86 });
await png(lockupWhite, 0, "desktop/logo-white@2x.png", { height: 86 });
// --- browser toolbar/store icons (plan B consumes these; generated now so one run produces everything)
for (const s of [16, 19, 32, 38, 48, 96, 128]) {
  await png(mark, s, `browser/icon${s}.png`);
  await png(markGrey, s, `browser/icon${s}_gray.png`);
}
for (const s of [19, 38]) await png(withLock(mark), s, `browser/icon${s}_locked.png`);
await png(appIcon, 128, "browser/store/chrome-icon128.png");
await png(appIcon, 64, "browser/store/icon64.png");
await png(appIcon, 300, "browser/store/windows-icon300.png");
console.log("generated into", OUT);

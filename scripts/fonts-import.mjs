#!/usr/bin/env node
/**
 * Import VARIABLE faces into the font library: read what the file actually
 * declares, convert to woff2, install into both apps, and print the registry
 * rows to paste into display-fonts.ts.
 *
 * The point is that nothing here is typed by hand. A variable face carries its
 * axis ranges in its own `fvar` table, and a wrong `@font-face` range is not a
 * cosmetic slip: declare a face as a single weight and the browser SYNTHESISES
 * bold, which shows up across the whole interface as smeared headings. So the
 * ranges are read out of the binary and emitted verbatim. Same for the family
 * name (`name` table, typographic ID 16) and for italic-ness (`OS/2`
 * fsSelection), both of which the filename only hints at.
 *
 *   node scripts/fonts-import.mjs <file.ttf>...      # convert + install + print
 *   node scripts/fonts-import.mjs --dry <file.ttf>...  # print only, touch nothing
 *
 * Files are named explicitly rather than globbed from a directory: WHICH faces
 * ship is a product decision (the 2-axis floor, which families get a real
 * italic), and it belongs in the command that ran, not in a flag matrix here.
 *
 * Licences ride along: the OFL/UFL beside the source is copied to
 * library/licenses/<slug>.txt, so a face can never ship without its terms.
 *
 * Sibling of fonts-to-woff2.mjs, which stays the plain converter for one-off
 * files (the Inter faces in public/Inter, say) that need no registry row.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress } from 'wawoff2';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Both apps serve a byte-identical library; display-fonts.test.ts asserts it. */
const APPS = ['client/web', 'server/web'];
const LIB = 'public/fonts/library';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('usage: fonts-import.mjs [--dry] <file.ttf>...');
  process.exit(1);
}

// ── sfnt reading ────────────────────────────────────────────────────────────
// Just enough of the spec to answer three questions: what is this family
// called, what axes does it have, and is it the italic file.

function tableDirectory(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables[buf.toString('latin1', p, p + 4)] = {
      offset: buf.readUInt32BE(p + 8),
      length: buf.readUInt32BE(p + 12),
    };
  }
  return tables;
}

/** `fvar` axis records: tag + min/default/max as 16.16 fixed point. */
function readAxes(buf, table) {
  if (!table) return [];
  const o = table.offset;
  const axesOffset = buf.readUInt16BE(o + 4);
  const axisCount = buf.readUInt16BE(o + 8);
  const axisSize = buf.readUInt16BE(o + 10);
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const p = o + axesOffset + i * axisSize;
    axes.push({
      tag: buf.toString('latin1', p, p + 4),
      min: buf.readInt32BE(p + 4) / 65536,
      def: buf.readInt32BE(p + 8) / 65536,
      max: buf.readInt32BE(p + 12) / 65536,
    });
  }
  return axes;
}

/**
 * A `name` table string. Windows/Unicode records are UTF-16BE, which node has
 * no decoder for, so the bytes are swapped and read as UTF-16LE. Windows
 * (platform 3) wins over Mac (platform 1) when a font ships both, because the
 * Mac record is MacRoman and mangles anything outside ASCII.
 */
function readName(buf, table, nameId) {
  if (!table) return null;
  const o = table.offset;
  const count = buf.readUInt16BE(o + 2);
  const stringOffset = buf.readUInt16BE(o + 4);
  // Ranked, not first-match: a font can carry several platform-3 records
  // (symbol encoding, localized languages) sorted ahead of the canonical one,
  // and the slug/registry key derive from this string. Prefer Windows Unicode
  // BMP English (3/1/0x409), then any Windows Unicode, then anything readable.
  let win = null;
  let winEnglish = null;
  let best = null;
  for (let i = 0; i < count; i++) {
    const p = o + 6 + i * 12;
    if (buf.readUInt16BE(p + 6) !== nameId) continue;
    const platformId = buf.readUInt16BE(p);
    const encodingId = buf.readUInt16BE(p + 2);
    const languageId = buf.readUInt16BE(p + 4);
    const len = buf.readUInt16BE(p + 8);
    const at = o + stringOffset + buf.readUInt16BE(p + 10);
    const raw = buf.subarray(at, at + len);
    const unicode = platformId === 3 || platformId === 0;
    if (unicode && raw.length % 2 !== 0) continue;
    const value = unicode ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    if (!value) continue;
    if (platformId === 3 && (encodingId === 1 || encodingId === 10)) {
      if (languageId === 0x409) winEnglish ??= value;
      win ??= value;
    }
    best ??= value;
  }
  return winEnglish ?? win ?? best;
}

/** OS/2 fsSelection bit 0 — the font's OWN claim to being italic, which is the
 *  only reliable answer (a filename is a convention, not a declaration). */
function isItalic(buf, table) {
  if (!table) return false;
  return (buf.readUInt16BE(table.offset + 62) & 1) === 1;
}

// ── CSS projection ──────────────────────────────────────────────────────────

const round = (n) => Math.round(n * 100) / 100;

/**
 * The three axes CSS can address through `@font-face` descriptors. Everything
 * else a face declares (GRAD, WONK, SOFT, ROND, YTLC, the Roboto Flex zoo) has
 * no descriptor and stays at its default unless something sets
 * font-variation-settings, so those are recorded as metadata only.
 */
function cssDescriptors(axes) {
  const out = {};
  const by = Object.fromEntries(axes.map((a) => [a.tag, a]));
  if (by.wght) out.weight = `${round(by.wght.min)} ${round(by.wght.max)}`;
  // `font-stretch`, not `font-width`: same descriptor, but the older spelling is
  // the one every browser that can render Mantle already accepts.
  if (by.wdth) out.stretch = `${round(by.wdth.min)}% ${round(by.wdth.max)}%`;
  // OpenType `slnt` is degrees COUNTER-clockwise (a right-leaning face is
  // negative); CSS `oblique` is degrees clockwise. So the sign flips, and the
  // flip also reverses which end is the range's minimum.
  if (by.slnt) out.oblique = `oblique ${round(-by.slnt.max)}deg ${round(-by.slnt.min)}deg`;
  return out;
}

function slugify(family) {
  return family
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

// ── read every source before writing anything ───────────────────────────────

const faces = [];
for (const file of files) {
  const buf = readFileSync(file);
  const tables = tableDirectory(buf);
  if (!tables.fvar) throw new Error(`${file}: no fvar table — not a variable font`);
  const axes = readAxes(buf, tables.fvar);
  if (axes.length < 2) {
    throw new Error(
      `${file}: only ${axes.length} axis (${axes.map((a) => a.tag).join(',')}) — the library is 2-axis minimum`,
    );
  }
  const family = readName(buf, tables.name, 16) || readName(buf, tables.name, 1);
  if (!family) throw new Error(`${file}: no family name in the name table`);
  faces.push({
    src: file,
    buf,
    family,
    slug: slugify(family),
    italic: isItalic(buf, tables['OS/2']),
    axes,
    css: cssDescriptors(axes),
  });
}

// One row per family; the italic file attaches to its roman sibling rather than
// becoming a second selectable entry (nobody picks "Inter Italic" as their UI
// font — the browser picks it when it paints italic text).
const byFamily = new Map();
for (const face of faces) {
  const row = byFamily.get(face.slug) ?? { slug: face.slug, family: face.family };
  if (face.italic) row.italic = face;
  else row.roman = face;
  byFamily.set(face.slug, row);
}

for (const [slug, row] of byFamily) {
  if (!row.roman) throw new Error(`${slug}: an italic file with no roman sibling`);
}

// ── write ───────────────────────────────────────────────────────────────────

let before = 0;
let after = 0;

for (const [slug, row] of byFamily) {
  for (const face of [row.roman, row.italic].filter(Boolean)) {
    const name = face.italic ? `${slug}-italic.woff2` : `${slug}.woff2`;
    const packed = Buffer.from(await compress(face.buf));
    // A "compressed" file that grew means the encoder fell back or the source
    // was already packed — never ship that silently.
    if (packed.length >= face.buf.length) {
      throw new Error(
        `${face.src}: woff2 (${packed.length}B) is not smaller than the source (${face.buf.length}B)`,
      );
    }
    before += face.buf.length;
    after += packed.length;
    if (!dry) for (const app of APPS) writeFileSync(join(ROOT, app, LIB, name), packed);
    console.error(
      `  ${basename(face.src)} → ${name}  ${kb(face.buf.length)} → ${kb(packed.length)}  (-${Math.round((1 - packed.length / face.buf.length) * 100)}%)`,
    );
  }
  // The licence sits beside the source, named by the foundry's convention
  // (OFL.txt for most of Google Fonts, UFL.txt for the Ubuntu faces).
  const dir = dirname(row.roman.src);
  const licence = readdirSync(dir).find((n) => /^(OFL|UFL|LICENSE)(\.txt)?$/i.test(n));
  if (!licence) throw new Error(`${slug}: no OFL/UFL/LICENSE beside ${row.roman.src}`);
  if (!dry) {
    const text = readFileSync(join(dir, licence));
    for (const app of APPS) writeFileSync(join(ROOT, app, LIB, 'licenses', `${slug}.txt`), text);
  }
}

console.error(
  `\n${faces.length} faces across ${byFamily.size} families: ${kb(before)} → ${kb(after)} ` +
    `(-${Math.round((1 - after / before) * 100)}%)${dry ? '  [dry run, nothing written]' : ''}\n`,
);

// ── emit ────────────────────────────────────────────────────────────────────
// stdout is the registry rows alone, so the command can be piped or diffed;
// progress and totals went to stderr above.

const rows = [...byFamily.values()].map((row) => {
  const { css, axes } = row.roman;
  const extra = axes.map((a) => a.tag).filter((t) => !['wght', 'wdth', 'slnt'].includes(t));
  return [
    `  {`,
    `    key: '${row.slug}',`,
    `    label: '${row.family}',`,
    `    family: '${row.family}',`,
    `    file: \`\${LIB}/${row.slug}.woff2\`,`,
    row.italic ? `    italicFile: \`\${LIB}/${row.slug}-italic.woff2\`,` : '',
    css.weight ? `    weight: '${css.weight}',` : '',
    css.stretch ? `    stretch: '${css.stretch}',` : '',
    css.oblique ? `    style: '${css.oblique}',` : '',
    extra.length ? `    axes: [${extra.map((t) => `'${t}'`).join(', ')}],` : '',
    `    // TODO fallback + shelf`,
    `  },`,
  ]
    .filter(Boolean)
    .join('\n');
});

console.log(rows.join('\n'));

function kb(n) {
  return `${Math.round(n / 1024)}K`;
}

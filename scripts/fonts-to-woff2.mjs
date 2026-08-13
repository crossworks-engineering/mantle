#!/usr/bin/env node
/**
 * Convert vendored .ttf/.otf faces to .woff2, in place.
 *
 * The font library ships as static files in BOTH apps' `public/`. woff2 is the only format any browser that can render
 * Mantle has needed since 2016, and it is ~70% smaller — a 1.6M face like Nabla
 * becomes ~400K, which is what a visitor pays the moment they select it.
 *
 * Conversion is byte-faithful: same glyphs, same coverage, same metrics, just
 * brotli-packed tables. Nothing is subsetted — a brain name is user text and may
 * be any script the face supports.
 *
 * `wawoff2` is the Google woff2 encoder compiled to wasm, so this needs no
 * system toolchain (no `brew install woff2`, no fontTools).
 *
 *   node scripts/fonts-to-woff2.mjs <file-or-dir>...   # writes <name>.woff2
 *   node scripts/fonts-to-woff2.mjs --prune <dir>      # ...and deletes the source
 *
 * Adding a face: drop the .ttf in, run this, commit the .woff2 only.
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { compress } from 'wawoff2';

const args = process.argv.slice(2);
const prune = args.includes('--prune');
const targets = args.filter((a) => a !== '--prune');

if (targets.length === 0) {
  console.error('usage: fonts-to-woff2.mjs [--prune] <file-or-dir>...');
  process.exit(1);
}

const SOURCE = /\.(ttf|otf)$/i;

function expand(target) {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target)
    .filter((n) => SOURCE.test(n))
    .map((n) => join(target, n));
}

const files = targets.flatMap(expand);
if (files.length === 0) {
  console.error('no .ttf/.otf found');
  process.exit(1);
}

let before = 0;
let after = 0;

for (const file of files) {
  const src = readFileSync(file);
  const out = Buffer.from(await compress(src));
  // A "compressed" file that grew means the encoder fell back or the source was
  // already packed — never ship that silently.
  if (out.length >= src.length) {
    throw new Error(
      `${file}: woff2 (${out.length}B) is not smaller than the source (${src.length}B)`,
    );
  }
  const dest = file.replace(new RegExp(`${extname(file)}$`), '.woff2');
  writeFileSync(dest, out);
  before += src.length;
  after += out.length;
  const pct = Math.round((1 - out.length / src.length) * 100);
  console.log(`${file} → ${dest}  ${kb(src.length)} → ${kb(out.length)}  (-${pct}%)`);
  if (prune) rmSync(file);
}

console.log(
  `\n${files.length} faces: ${kb(before)} → ${kb(after)} (-${Math.round((1 - after / before) * 100)}%)` +
    (prune ? ', sources removed' : ''),
);

function kb(n) {
  return `${Math.round(n / 1024)}K`;
}

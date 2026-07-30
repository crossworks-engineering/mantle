// Generate the demo brain's content. Deterministic: same --seed → identical
// bytes, everywhere. Emits an intermediate representation (manifest.json)
// plus REAL file bytes — the P3 seeder consumes both and drives the app's
// own APIs, so nothing here writes to a database.
//
// Dates stay OFFSETS in the IR and are resolved to absolute timestamps at
// SEED time, which is what keeps a freshly seeded demo always looking
// current.
//
//   node gen.mjs [--seed 1] [--out out]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeRng } from './lib/rng.mjs';
import { targets, SPAN } from './lib/world.mjs';
import { pdf, png, xlsx, docx } from './lib/binfmt.mjs';

import * as pumphouse from './content/pumphouse.mjs';
import * as storefront from './content/storefront.mjs';
import * as island from './content/island.mjs';
import * as handbook from './content/handbook.mjs';
import * as personal from './content/personal.mjs';
import * as studio from './content/studio.mjs';
import * as traffic from './content/traffic.mjs';
import * as turns from './content/turns.mjs';

const MODULES = { studio, pumphouse, storefront, island, handbook, personal, traffic, turns };

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const SEED = Number(argVal('--seed', 1));
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, argVal('--out', 'out'));

export function generateAll(seed = 1) {
  const rng = makeRng(seed);
  const all = { nodes: [], tables: [], emails: [], files: [], docs: [], turns: [] };
  for (const [name, mod] of Object.entries(MODULES)) {
    const r = mod.generate(rng);
    for (const key of Object.keys(all)) for (const item of r[key] ?? []) all[key].push({ ...item, _module: name });
  }
  return all;
}

// Render a file spec to real bytes. The P3 ingest runs Tika and the image
// path over these, so wrong magic bytes would fail there, not here.
export function renderFile(f) {
  switch (f.kind) {
    case 'pdf':  return pdf(f.title, f.text);
    case 'png':  return png(320, 200, f.pngSeed ?? 1);
    case 'xlsx': return xlsx(f.sheet ?? 'Sheet1', f.rows);
    case 'docx': return docx(f.blocks);
    case 'md':   return Buffer.from(f.text.join('\n\n'), 'utf8');
    default: throw new Error(`unknown file kind '${f.kind}' (${f.id})`);
  }
}

function main() {
  const all = generateAll(SEED);

  // Fail loudly on anything structurally wrong before writing a byte.
  const problems = [];
  const ids = new Set();
  for (const key of ['nodes', 'tables', 'emails', 'files']) {
    for (const item of all[key]) {
      if (ids.has(item.id)) problems.push(`duplicate id: ${item.id}`);
      ids.add(item.id);
      const off = item.offset ?? item.meta?.start_offset;
      if (off != null && (off < SPAN[0] || off > SPAN[1])) problems.push(`${item.id}: offset ${off} outside span ${SPAN}`);
    }
  }
  if (problems.length) { console.error('GENERATION FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'files'), { recursive: true });
  mkdirSync(join(OUT, 'docs'), { recursive: true });

  // File bytes + content hashes (hashes make the determinism test cheap).
  const fileIndex = all.files.map((f) => {
    const bytes = renderFile(f);
    writeFileSync(join(OUT, 'files', f.name), bytes);
    return {
      id: f.id, name: f.name, title: f.title, branch: f.branch, kind: f.kind,
      offset: f.offset, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      text: f.text ?? null, _module: f._module,
    };
  });

  // Documentation collection: on-disk markdown, indexed retrieval-only.
  for (const d of all.docs) {
    const p = join(OUT, 'docs', d.collection, d.relpath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d.body, 'utf8');
  }

  const manifest = {
    seed: SEED,
    span: SPAN,
    generated_by: 'demo/generator/gen.mjs',
    note: 'Offsets are days relative to SEED TIME and are resolved by the P3 seeder. All content is fictional; see demo/world/.',
    counts: {
      // files / tables / documentation are node TYPES in Mantle but travel in
      // their own IR arrays — fold them in so the target report counts what
      // the brain will actually hold.
      nodes_by_kind: {
        ...all.nodes.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
        file: all.files.length,
        table: all.tables.length,
        documentation: all.docs.length,
      },
      emails: all.emails.length, turns: all.turns.length,
    },
    nodes: all.nodes, tables: all.tables, emails: all.emails,
    files: fileIndex, docs: all.docs.map(({ collection, relpath, title }) => ({ collection, relpath, title })),
    turns: all.turns,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Report against targets — under-production is the v1 failure, so say so.
  const counts = manifest.counts.nodes_by_kind;
  console.log(`\ndemo generator — seed ${SEED} → ${OUT}\n`);
  const rows = [];
  for (const [kind, spec] of Object.entries(targets.nodes)) {
    const n = counts[kind] ?? 0;
    rows.push([kind, n, spec.target, spec.min, n >= spec.min ? 'ok' : 'UNDER']);
  }
  rows.push(['emails', all.emails.length, targets.emails.target, targets.emails.min, all.emails.length >= targets.emails.min ? 'ok' : 'UNDER']);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('type', 16)}${pad('got', 7)}${pad('target', 8)}${pad('min', 7)}status`);
  for (const r of rows) console.log(`${pad(r[0], 16)}${pad(r[1], 7)}${pad(r[2], 8)}${pad(r[3], 7)}${r[4]}`);
  console.log(`\nfiles ${all.files.length} · docs ${all.docs.length} · scripted turns ${all.turns.length}`);
  const under = rows.filter((r) => r[4] === 'UNDER');
  if (under.length) {
    console.error(`\n✗ ${under.length} type(s) under the minimum: ${under.map((r) => r[0]).join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ all types at or above their minimum');
}

if (import.meta.url === `file://${process.argv[1]}`) main();

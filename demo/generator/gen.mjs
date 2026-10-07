// Generate the demo brain's content. Deterministic: same --seed, identical
// bytes, everywhere. Emits an intermediate representation (manifest.json)
// plus REAL file bytes; the seeder consumes both and drives the app's own
// APIs, so nothing here writes to a database.
//
// Dates stay OFFSETS in the IR and are resolved to absolute timestamps at
// SEED time, which keeps a freshly seeded demo always looking current.
//
// v2 (2026-10-07): one firm, five people, two projects, a handful of
// polished items per workspace, and the four sharing levels shown the same
// way in every workspace that can share (content/folders.mjs).
//
//   node gen.mjs [--seed 1] [--out out]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeRng } from './lib/rng.mjs';
import { targets, SPAN, worldDir } from './lib/world.mjs';
import { pdf, xlsx, docx } from './lib/binfmt.mjs';

import * as folders from './content/folders.mjs';
import * as files from './content/files.mjs';
import * as tables from './content/tables.mjs';
import * as draws from './content/draws.mjs';
import * as formulas from './content/formulas.mjs';
import * as apps from './content/apps.mjs';
import * as pages from './content/pages.mjs';
import * as notes from './content/notes.mjs';
import * as work from './content/work.mjs';
import * as email from './content/email.mjs';
import * as recall from './content/recall.mjs';
import * as automation from './content/automation.mjs';
import * as docs from './content/docs.mjs';
import * as turns from './content/turns.mjs';
import { tierFolder, TREE_OF } from './content/folders.mjs';

const MODULES = { folders, files, tables, draws, formulas, apps, pages, notes, work, email, recall, automation, docs, turns };

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const SEED = Number(argVal('--seed', 1));
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, argVal('--out', 'out'));

const KEYS = ['nodes', 'tables', 'emails', 'files', 'docs', 'turns', 'heartbeats', 'draws', 'folders', 'recall_maps', 'apps'];

/** The order the seeder creates things in. A `gen:` reference may only point
 *  at something created earlier, because the real id must exist by then. */
export const CREATE_ORDER = ['contact', 'file', 'table', 'draw', 'formula', 'app', 'page', 'note', 'journal', 'task', 'event', 'secret'];

/** Every item that can live in a tree, with its node type. */
export function treeItems(all) {
  return [
    ...all.nodes.map((n) => ({ item: n, type: n.kind })),
    ...all.tables.map((t) => ({ item: t, type: 'table' })),
    ...all.files.map((f) => ({ item: f, type: 'file' })),
    ...all.draws.map((d) => ({ item: d, type: 'draw' })),
    ...all.apps.map((a) => ({ item: a, type: 'app' })),
  ];
}
/** The folder an item sits in (generator id), or null for the top level. */
export const folderOf = (item) => item.meta?.folder ?? item.folder ?? null;

export function generateAll(seed = 1) {
  const rng = makeRng(seed);
  const all = Object.fromEntries(KEYS.map((k) => [k, []]));
  for (const [name, mod] of Object.entries(MODULES)) {
    const r = mod.generate(rng.fork(name));
    for (const key of KEYS) for (const item of r[key] ?? []) all[key].push({ ...item, _module: name });
  }
  // A tier becomes a folder (or, for public, the top level and a link).
  const place = (item, type) => {
    if (!item.tier) return item;
    const folder = tierFolder(type, item.tier);
    const pub = item.tier === 'public' ? { public: true } : {};
    return item.meta !== undefined && type !== 'table' && type !== 'file' && type !== 'draw' && type !== 'app'
      ? { ...item, ...pub, meta: { ...item.meta, folder } }
      : { ...item, ...pub, folder };
  };
  all.nodes = all.nodes.map((n) => place(n, n.kind));
  all.tables = all.tables.map((t) => place(t, 'table'));
  all.files = all.files.map((f) => place(f, 'file'));
  all.draws = all.draws.map((d) => place(d, 'draw'));
  all.apps = all.apps.map((a) => place(a, 'app'));
  // What each share must reach: the items in the folder (no subfolders here).
  const items = treeItems(all);
  all.folders = all.folders.map((f) => {
    if (!f.share) return f;
    const inside = items.filter(({ item }) => folderOf(item) === f.id).length;
    return { ...f, expect: { items: inside, folders: 0 } };
  });
  return all;
}

/** The brain's limit: a folder sits one to three levels below its kind's root. */
export const MAX_FOLDER_DEPTH = 3;

// ── References inside page and note bodies ──────────────────────────────────
// `media:gen:<id>` (an image or a file), `page:gen:<id>` (a page link card)
// embed; `mention:node:gen:<id>` links. An embed must stay in its own tier
// (a share must never reach through it); a mention may point at anything the
// item's readers can also read.
const REF_RE = /\((media|page|mention:node|draw):gen:([A-Za-z0-9._-]+)\)/g;
export function refsOf(body) {
  return [...(body ?? '').matchAll(REF_RE)].map((m) => ({ scheme: m[1], id: m[2], embed: m[1] !== 'mention:node' }));
}
/** Which tiers a reader of `from` can also read. */
const READABLE = {
  private: ['private', 'team', 'client', 'public'],
  team: ['team', 'client', 'public'],
  client: ['client'],
  public: ['public'],
};

export function structuralProblems(all) {
  const problems = [];
  const folderById = new Map(all.folders.map((f) => [f.id, f]));
  for (const f of all.folders) {
    if (f.parent && !folderById.has(f.parent)) problems.push(`folder ${f.id}: parent ${f.parent} does not exist`);
    if (f.share && !['files', 'notes', 'pages', 'tables', 'draw', 'formulas', 'apps'].includes(f.kind)) problems.push(`folder ${f.id}: a ${f.kind} folder cannot be shared`);
    if (f.share && !f.expect?.items) problems.push(`folder ${f.id}: shared, but nothing is in it`);
  }
  const treeKindOf = { ...TREE_OF, task: 'tasks', event: 'events', contact: 'contacts', secret: 'secrets' };
  const items = treeItems(all);
  const byId = new Map(items.map(({ item, type }) => [item.id, { item, type }]));
  const rank = (type) => CREATE_ORDER.indexOf(type);
  const position = new Map(items.map(({ item }, i) => [item.id, i]));
  for (const { item, type } of items) {
    const folder = folderOf(item);
    if (folder != null) {
      const f = folderById.get(folder);
      if (!f) problems.push(`${item.id}: folder ${folder} does not exist`);
      else if (f.kind !== treeKindOf[type]) problems.push(`${item.id}: a ${type} cannot sit in a ${f.kind} folder`);
    }
    if (item.public && folder != null) problems.push(`${item.id}: a public item sits at the top level`);
    const fromTier = item.tier ?? 'private';
    for (const ref of refsOf(item.body)) {
      const target = byId.get(ref.id);
      if (!target) { problems.push(`${item.id}: ${ref.scheme}:gen:${ref.id} names nothing`); continue; }
      const before = rank(target.type) < rank(type) || (target.type === type && position.get(ref.id) < position.get(item.id));
      if (!before) problems.push(`${item.id}: refers to ${ref.id}, which the seeder creates later`);
      const toTier = target.item.tier ?? 'private';
      if (ref.embed && fromTier !== 'private' && toTier !== fromTier) problems.push(`${item.id} (${fromTier}) embeds ${ref.id} (${toTier}): embeds stay in their tier`);
      if (!ref.embed && !READABLE[fromTier].includes(toTier)) problems.push(`${item.id} (${fromTier}) mentions ${ref.id} (${toTier}), which its readers cannot read`);
    }
  }
  for (const map of all.recall_maps) {
    const slugs = new Set(['start', ...map.cards.map((c) => c.slug)]);
    if (slugs.size !== map.cards.length + 1) problems.push(`recall ${map.slug}: duplicate card slug (or a card named 'start')`);
    if (!map.enter_when?.trim()) problems.push(`recall ${map.slug}: no enter_when line`);
    const reached = new Set();
    for (const card of [{ slug: 'start', ...map.entry }, ...map.cards]) {
      if (card.kind === 'prompt' && !card.use_when?.trim()) problems.push(`recall ${map.slug}/${card.slug}: a prompt needs a use_when line`);
      for (const o of card.options ?? []) {
        reached.add(o.target);
        if (!slugs.has(o.target)) problems.push(`recall ${map.slug}/${card.slug}: option "${o.label}" leads to unknown card ${o.target}`);
        if (!o.use_when?.trim()) problems.push(`recall ${map.slug}/${card.slug}: option "${o.label}" has no use_when line`);
      }
    }
    for (const c of map.cards) if (!reached.has(c.slug)) problems.push(`recall ${map.slug}: nothing leads to card ${c.slug}`);
  }
  return problems;
}

// Render a file spec to real bytes. The seed's ingest runs Tika and the image
// path over these, so wrong magic bytes would fail there, not here.
export function renderFile(f) {
  switch (f.kind) {
    case 'image': return readFileSync(join(worldDir, 'art', f.name));
    case 'pdf':  return pdf(f.title, f.text);
    case 'xlsx': return xlsx(f.sheet ?? 'Sheet1', f.rows);
    case 'docx': return docx(f.blocks);
    default: throw new Error(`unknown file kind '${f.kind}' (${f.id})`);
  }
}

function main() {
  const all = generateAll(SEED);

  const problems = [];
  const ids = new Set();
  for (const key of ['nodes', 'tables', 'emails', 'files', 'folders', 'recall_maps', 'draws', 'apps']) {
    for (const item of all[key]) {
      if (ids.has(item.id)) problems.push(`duplicate id: ${item.id}`);
      ids.add(item.id);
      const off = item.offset ?? item.meta?.start_offset;
      if (off != null && (off < SPAN[0] || off > SPAN[1])) problems.push(`${item.id}: offset ${off} outside span ${SPAN}`);
    }
  }
  problems.push(...structuralProblems(all));
  if (problems.length) { console.error('GENERATION FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'files'), { recursive: true });
  mkdirSync(join(OUT, 'docs'), { recursive: true });

  const fileIndex = all.files.map((f) => {
    const bytes = renderFile(f);
    writeFileSync(join(OUT, 'files', f.name), bytes);
    return {
      id: f.id, name: f.name, title: f.title, kind: f.kind, tier: f.tier, folder: f.folder ?? null,
      public: f.public ?? false, offset: f.offset, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      text: f.text ?? null, _module: f._module,
    };
  });

  for (const d of all.docs) {
    const p = join(OUT, 'docs', d.collection, d.relpath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d.body, 'utf8');
  }

  const manifest = {
    seed: SEED,
    span: SPAN,
    generated_by: 'demo/generator/gen.mjs',
    note: 'Offsets are days relative to SEED TIME and are resolved by the seeder. All content is fictional; see demo/world/.',
    counts: {
      nodes_by_kind: {
        ...all.nodes.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
        file: all.files.length,
        table: all.tables.length,
        documentation: all.docs.length,
        draw: all.draws.length,
        app: all.apps.length,
      },
      emails: all.emails.length, turns: all.turns.length, heartbeats: all.heartbeats.length,
      folders: all.folders.length, recall_maps: all.recall_maps.length,
    },
    nodes: all.nodes, tables: all.tables, emails: all.emails,
    files: fileIndex, docs: all.docs.map(({ collection, relpath, title }) => ({ collection, relpath, title })),
    turns: all.turns, heartbeats: all.heartbeats, draws: all.draws,
    folders: all.folders, recall_maps: all.recall_maps, apps: all.apps,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const counts = { ...manifest.counts.nodes_by_kind, recall: all.recall_maps.length };
  console.log(`\ndemo generator: seed ${SEED} → ${OUT}\n`);
  const rows = [];
  for (const [kind, spec] of Object.entries(targets.nodes)) {
    const n = counts[kind] ?? 0;
    rows.push([kind, n, spec.target, spec.min, n >= spec.min ? 'ok' : 'UNDER']);
  }
  rows.push(['emails', all.emails.length, targets.emails.target, targets.emails.min, all.emails.length >= targets.emails.min ? 'ok' : 'UNDER']);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('type', 16)}${pad('got', 7)}${pad('target', 8)}${pad('min', 7)}status`);
  for (const r of rows) console.log(`${pad(r[0], 16)}${pad(r[1], 7)}${pad(r[2], 8)}${pad(r[3], 7)}${r[4]}`);
  console.log(`\nfolders ${all.folders.length} · shared ${all.folders.filter((f) => f.share).length} · public items ${treeItems(all).filter(({ item }) => item.public).length} · docs ${all.docs.length} · owner chats ${all.turns.length}`);
  const under = rows.filter((r) => r[4] === 'UNDER');
  if (under.length) {
    console.error(`\n✗ ${under.length} type(s) under the minimum: ${under.map((r) => r[0]).join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ all types at or above their minimum');
}

if (import.meta.url === `file://${process.argv[1]}`) main();

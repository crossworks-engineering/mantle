// Layer-1 tests: no Docker, no database, no network. Runs anywhere.
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateAll, renderFile, structuralProblems, treeItems, folderOf, refsOf } from '../gen.mjs';
import { world, targets, owner, SPAN } from '../lib/world.mjs';
import { scanText } from '../guard.mjs';

const gen = generateAll(1);
const allText = [
  ...gen.nodes.flatMap((n) => [n.title, n.body]),
  ...gen.emails.flatMap((e) => [e.subject, e.body, e.from, ...e.to, ...e.cc]),
  ...gen.tables.flatMap((t) => [t.title, ...t.columns.map((c) => c.name), ...t.rows.flat().map(String)]),
  ...gen.files.flatMap((f) => [f.title, ...(f.text ?? [])]),
  ...gen.draws.flatMap((d) => [d.title, ...d.scene.elements.map((e) => e.text ?? '')]),
  ...gen.apps.flatMap((a) => [a.name, a.description]),
  ...gen.docs.map((d) => d.body),
  ...gen.turns.map((t) => t.prompt),
  ...gen.heartbeats.flatMap((h) => [h.name, h.description]),
  ...gen.folders.map((f) => f.name),
  ...gen.recall_maps.flatMap((m) => [
    m.title, m.enter_when, m.entry.body,
    ...m.cards.flatMap((c) => [c.title, c.body, c.use_when]),
    ...[m.entry, ...m.cards].flatMap((c) => (c.options ?? []).flatMap((o) => [o.label, o.use_when])),
  ]),
].filter(Boolean).join('\n');

// ── Determinism ──────────────────────────────────────────────────────────────
test('same seed produces identical content and file bytes', () => {
  const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.equal(h(generateAll(1)), h(generateAll(1)));
  const bytes = () => generateAll(1).files.map((f) => createHash('sha256').update(renderFile(f)).digest('hex'));
  assert.deepEqual(bytes(), bytes());
});

test('every image is a real JPEG from demo/world/art', () => {
  const images = gen.files.filter((f) => f.kind === 'image');
  assert.ok(images.length >= 15 && images.length <= 25, `${images.length} images`);
  for (const f of images) {
    const b = renderFile(f);
    assert.ok(b[0] === 0xff && b[1] === 0xd8, `${f.name} is not a JPEG`);
  }
});

// ── Shape ────────────────────────────────────────────────────────────────────
test('no structural problems (folders, references, tiers, Recall maps)', () => {
  assert.deepEqual(structuralProblems(gen), []);
});

test('every node type meets its target exactly, emails too', () => {
  const counts = {
    ...gen.nodes.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
    file: gen.files.length, table: gen.tables.length, draw: gen.draws.length, app: gen.apps.length,
    documentation: gen.docs.length, recall: gen.recall_maps.length,
  };
  for (const [kind, spec] of Object.entries(targets.nodes)) assert.equal(counts[kind] ?? 0, spec.target, kind);
  assert.equal(gen.emails.length, targets.emails.target);
});

test('the world is one firm, five people, two projects', () => {
  assert.equal(world.companies.filter((c) => c.kind === 'own-studio').length, 1);
  assert.equal(world.people.length + 1, 5);
  assert.equal(world.projects.length, 2);
});

test('every offset is inside the span', () => {
  for (const x of [...gen.nodes, ...gen.tables, ...gen.files, ...gen.emails, ...gen.draws, ...gen.apps]) {
    const off = x.offset ?? x.meta?.start_offset;
    assert.ok(off >= SPAN[0] && off <= SPAN[1], `${x.id}: ${off}`);
  }
});

// ── The four levels ──────────────────────────────────────────────────────────
test('each workspace that can share has a Private, a Team and a Client folder', () => {
  for (const kind of ['files', 'notes', 'pages', 'tables', 'draw', 'formulas', 'apps']) {
    const mine = gen.folders.filter((f) => f.kind === kind);
    assert.deepEqual(mine.map((f) => f.share ?? 'private').sort(), ['client', 'private', 'team'], kind);
    for (const f of mine) {
      const inside = treeItems(gen).filter(({ item }) => folderOf(item) === f.id).length;
      assert.ok(inside > 0, `${f.id} is empty`);
      if (f.share) assert.deepEqual(f.expect, { items: inside, folders: 0 }, `${f.id} expect`);
    }
  }
});

test('public items sit at the top level, and a page with a link embeds only public images', () => {
  const pub = treeItems(gen).filter(({ item }) => item.public);
  assert.ok(pub.length >= targets.access.public_items.min);
  for (const { item } of pub) assert.equal(folderOf(item), null, item.id);
  const byId = new Map(treeItems(gen).map(({ item }) => [item.id, item]));
  for (const { item } of pub) {
    for (const ref of refsOf(item.body).filter((r) => r.embed)) assert.equal(byId.get(ref.id)?.public, true, `${item.id} embeds ${ref.id}`);
  }
});

test('the tasks and events give the dashboard a future', () => {
  const ahead = gen.nodes.filter((n) => (n.kind === 'event' && n.meta.start_offset > 0) || (n.kind === 'task' && n.meta.status === 'open' && n.meta.due_offset > 0));
  assert.ok(ahead.length >= 5, `${ahead.length} future items`);
});

// ── Content rules ────────────────────────────────────────────────────────────
test('every email address in content is the cast, on an RFC 2606 domain', () => {
  const cast = new Set([owner.email, ...world.people.map((p) => p.email)]);
  for (const m of allText.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) assert.ok(cast.has(m[0]), m[0]);
  for (const e of gen.emails) for (const a of [e.from, ...e.to, ...e.cc]) assert.ok(cast.has(a), a);
});

test('the publish guard finds nothing in any generated text', () => {
  assert.deepEqual(scanText(allText, 'generated', []), []);
});

test('house style: no em dashes, and no en dash used as a sentence break', () => {
  assert.ok(!allText.includes('—'), 'an em dash in generated content');
  assert.ok(!/ – /.test(allText), 'an en dash used as a sentence break');
});

test('page markdown has exactly one math block and no stray tildes', () => {
  const pages = gen.nodes.filter((n) => n.kind === 'page').map((n) => n.body).join('\n');
  // Two $ make math and two ~ make strike-through in the page dialect.
  assert.equal((pages.match(/\$\$/g) ?? []).length, 2);
  assert.equal((pages.replace(/\$\$[^$]*\$\$/g, '').match(/\$/g) ?? []).length, 0);
  assert.equal((pages.match(/~~/g) ?? []).length, 0);
});

test('five real chats: four owner turns here, the member question in the seed', () => {
  assert.equal(gen.turns.length, 4);
  for (const t of gen.turns) assert.equal(t.agent, 'assistant');
});

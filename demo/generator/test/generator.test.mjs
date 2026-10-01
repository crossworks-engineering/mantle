// Layer-1 tests: no Docker, no database, no network. Runs anywhere.
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateAll, renderFile, structuralProblems, MAX_FOLDER_DEPTH } from '../gen.mjs';
import { world, targets, owner, SPAN } from '../lib/world.mjs';
import { makeRng } from '../lib/rng.mjs';
import { scanText } from '../guard.mjs';

const gen = generateAll(1);
const allText = [
  ...gen.nodes.flatMap((n) => [n.title, n.body]),
  ...gen.emails.flatMap((e) => [e.subject, e.body, e.from, ...e.to]),
  ...gen.tables.flatMap((t) => [t.title, ...t.rows.flat().map(String)]),
  ...gen.docs.map((d) => d.body),
  ...gen.turns.map((t) => t.prompt),
  ...gen.folders.map((f) => f.name),
  ...gen.recall_maps.flatMap((m) => [
    m.title, m.enter_when, m.entry.body,
    ...m.cards.flatMap((c) => [c.title, c.body, c.use_when]),
    ...[m.entry, ...m.cards].flatMap((c) => (c.options ?? []).flatMap((o) => [o.label, o.use_when])),
  ]),
].filter(Boolean).join('\n');

// ── Determinism ──────────────────────────────────────────────────────────────
test('same seed produces identical content', () => {
  const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.equal(h(generateAll(1)), h(generateAll(1)));
});

test('same seed produces identical file bytes', () => {
  const a = generateAll(1).files.map((f) => createHash('sha256').update(renderFile(f)).digest('hex'));
  const b = generateAll(1).files.map((f) => createHash('sha256').update(renderFile(f)).digest('hex'));
  assert.deepEqual(a, b);
});

// Same-platform equality cannot catch encoder drift: node:zlib's deflateSync
// output varies with the linked zlib build, so identical pixels once produced
// different PNG bytes on macOS and Linux. These pinned hashes are the
// cross-platform guarantee — if an encoder changes, this fails everywhere
// rather than silently on one machine.
test('rendered file bytes match their pinned hashes (cross-platform)', () => {
  const GOLDEN = {
    png:  '0e414590b619668966f83add6225e28a2dc2f01252dfe577c721b204a466a785',
    pdf:  '8e06e985c298943ef9e85b5817513481f5cb0c1bce32cba12fe281058f9f9e0c',
    xlsx: 'b299e42227d6a8ec6bfe58482cf805d16131f7cb2fa893f8981c51535a8fe325',
    docx: '601c06f56e5a4d0c3216be485c4bc0d32cdeb828eda3dc2098c1d1192df8b755',
  };
  const actual = {};
  for (const kind of Object.keys(GOLDEN)) {
    const f = gen.files.find((x) => x.kind === kind);
    actual[kind] = createHash('sha256').update(renderFile(f)).digest('hex');
  }
  // Self-check: hashing must be stable within a run before the pin means anything.
  for (const kind of Object.keys(GOLDEN)) {
    const f = gen.files.find((x) => x.kind === kind);
    assert.equal(createHash('sha256').update(renderFile(f)).digest('hex'), actual[kind]);
  }
  const pinned = Object.entries(GOLDEN).filter(([, v]) => v);
  for (const [kind, want] of pinned) {
    assert.equal(actual[kind], want, `${kind} bytes changed — update the pin ONLY if the encoder change is intended`);
  }
});

test('a different seed produces different content', () => {
  const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.notEqual(h(generateAll(1)), h(generateAll(2)));
});

test('rng.fork is stable and stream-independent', () => {
  const a = makeRng(7), b = makeRng(7);
  a.int(0, 100); // perturb the parent stream only
  assert.equal(b.fork('x').int(0, 1e9), makeRng(7).fork('x').int(0, 1e9));
});

// ── Referential closure against the world bible ──────────────────────────────
test('every email address belongs to the cast', () => {
  const known = new Set([owner.email, ...world.people.map((p) => p.email)]);
  const used = new Set();
  for (const e of gen.emails) { used.add(e.from); e.to.forEach((t) => used.add(t)); (e.cc ?? []).forEach((c) => used.add(c)); }
  for (const addr of used) assert.ok(known.has(addr), `email address not in the world bible: ${addr}`);
});

test('every contact node matches a bible person exactly', () => {
  const contacts = gen.nodes.filter((n) => n.kind === 'contact');
  const names = new Set([owner.name, ...world.people.map((p) => p.name)]);
  assert.equal(contacts.length, world.people.length + 1, 'contacts must be exactly the cast');
  for (const c of contacts) assert.ok(names.has(c.title), `contact not in the bible: ${c.title}`);
});

test('no real-world company or person names leak in from the donor brains', () => {
  // Positive control: the bible's own names must appear; anything shaped like
  // a company suffix that is NOT ours is worth a human look.
  assert.ok(allText.includes('Harbour Labs'));
  assert.ok(allText.includes('Meridian Waterworks'));
  const suspicious = allText.match(/\b[A-Z][a-z]+ (?:Pty|Ltd|Inc|GmbH|LLC)\b/g) ?? [];
  assert.deepEqual(suspicious, [], `unexpected corporate-suffix names: ${suspicious.join(', ')}`);
});

// ── The publish guard, over generated content ────────────────────────────────
test('generated content passes the publish guard', () => {
  const findings = scanText(allText, 'generated', []);
  assert.deepEqual(findings, [], `publish guard findings: ${JSON.stringify(findings.slice(0, 5))}`);
});

test('the publish guard actually catches a leak (negative control)', () => {
  const findings = scanText('mail me at someone@realcompany.co.za or ssh 192.168.100.75', 'x', []);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['email', 'private-ip']);
});

// ── Dates ────────────────────────────────────────────────────────────────────
test('every offset falls inside the world span', () => {
  for (const n of [...gen.nodes, ...gen.emails, ...gen.tables, ...gen.files]) {
    const offs = [n.offset, n.meta?.start_offset, n.meta?.due_offset].filter((o) => o != null);
    for (const o of offs) assert.ok(o >= SPAN[0] && o <= SPAN[1], `${n.id}: offset ${o} outside ${SPAN}`);
  }
});

test('there is a future: events after seed time', () => {
  const future = gen.nodes.filter((n) => n.kind === 'event' && (n.meta.start_offset ?? 0) > 0);
  assert.ok(future.length >= 6, `only ${future.length} future events; the dashboard would look dead`);
});

test('activity is denser near seed time', () => {
  const dated = gen.nodes.filter((n) => n.offset < 0);
  const last30 = dated.filter((n) => n.offset >= -30).length;
  assert.ok(last30 / dated.length > 0.15, `only ${Math.round((last30 / dated.length) * 100)}% of activity in the last 30 days`);
});

// ── Volume targets ───────────────────────────────────────────────────────────
test('every node type meets its minimum', () => {
  // files/tables/documentation are node TYPES but travel in their own arrays
  const counts = {
    ...gen.nodes.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
    file: gen.files.length, table: gen.tables.length, documentation: gen.docs.length,
  };
  for (const [kind, spec] of Object.entries(targets.nodes)) {
    assert.ok((counts[kind] ?? 0) >= spec.min, `${kind}: ${counts[kind] ?? 0} < min ${spec.min}`);
  }
});

test('emails meet their minimum and are threaded', () => {
  assert.ok(gen.emails.length >= targets.emails.min, `${gen.emails.length} < ${targets.emails.min}`);
  const threads = new Set(gen.emails.map((e) => e.thread));
  assert.ok(threads.size >= 10, `only ${threads.size} threads`);
  const multi = [...threads].filter((t) => gen.emails.filter((e) => e.thread === t).length > 1);
  assert.ok(multi.length >= 5, 'need real back-and-forth threads, not just singletons');
});

// ── Structural features the demo is meant to show off ────────────────────────
test('procedure revision families form supersession chains', () => {
  const fams = {};
  for (const n of gen.nodes.filter((n) => n.meta?.family)) (fams[n.meta.family] ??= []).push(n);
  assert.ok(Object.keys(fams).length >= 3, 'need ≥3 revision families');
  for (const [fam, revs] of Object.entries(fams)) {
    assert.equal(revs.length, 3, `${fam} should have revs A,B,C`);
    const byRev = Object.fromEntries(revs.map((r) => [r.meta.rev, r]));
    assert.equal(byRev.A.meta.supersedes, null);
    assert.equal(byRev.B.meta.supersedes, byRev.A.id);
    assert.equal(byRev.C.meta.supersedes, byRev.B.id);
    assert.ok(byRev.C.offset > byRev.A.offset, 'later revisions must be newer');
  }
});

// Pages stopped nesting on main in v0.232.365 (folder phase 7): a page is
// never the parent of a page, and the depth lives in the folders.
test('no page has a page parent', () => {
  const nested = gen.nodes.filter((n) => n.kind === 'page' && n.meta?.parent_id);
  assert.deepEqual(nested.map((n) => n.id), [], 'pages do not nest: file them in a folder (meta.folder)');
});

test('folders nest at least two deep and never deeper than the brain allows', () => {
  const byId = Object.fromEntries(gen.folders.map((f) => [f.id, f]));
  const depth = (f) => (f.parent ? 1 + depth(byId[f.parent]) : 1);
  for (const kind of ['pages', 'notes']) {
    const depths = gen.folders.filter((f) => f.kind === kind).map(depth);
    assert.ok(Math.max(...depths) >= 2, `the ${kind} tree is flat: no folder inside a folder`);
    assert.ok(Math.max(...depths) <= MAX_FOLDER_DEPTH, `a ${kind} folder is deeper than ${MAX_FOLDER_DEPTH} levels; the brain refuses it`);
  }
});

test('folders and Recall maps are structurally sound', () => {
  assert.deepEqual(structuralProblems(gen), []);
});

test('the structural check catches what the brain would refuse (negative control)', () => {
  const bad = {
    ...gen,
    folders: [
      ...gen.folders,
      { id: 'x1', kind: 'pages', parent: 'hb-f-kit', name: 'Third level, allowed' },
      { id: 'x2', kind: 'notes', parent: 'x1', name: 'Wrong tree' },
      { id: 'x3', kind: 'pages', parent: 'x1', name: 'Fourth level' },
    ],
    nodes: [...gen.nodes, { id: 'p1', kind: 'page', title: 't', body: '', meta: { folder: 'fld-notes-island', parent_id: 'hb-root' } }],
    recall_maps: [{ ...gen.recall_maps[0], entry: { body: '', options: [{ label: 'Nowhere', target: 'no-such-card', use_when: 'never' }] } }],
  };
  const found = structuralProblems(bad).join('\n');
  assert.ok(!found.includes('folder x1:'), 'a third-level folder is allowed');
  for (const probe of ['x3: deeper than', 'x2: parent x1 is in another tree', 'p1: a page cannot sit in a notes folder', 'p1: pages do not nest', 'leads to unknown card no-such-card']) {
    assert.ok(found.includes(probe), `not caught: ${probe}\n${found}`);
  }
});

test('pages and notes are filed: every folder holds something, and some items stay unsorted', () => {
  for (const [kind, tree] of [['page', 'pages'], ['note', 'notes']]) {
    const items = gen.nodes.filter((n) => n.kind === kind);
    const used = new Set(items.map((n) => n.meta.folder).filter(Boolean));
    const parents = new Set(gen.folders.map((f) => f.parent).filter(Boolean));
    for (const f of gen.folders.filter((x) => x.kind === tree)) {
      assert.ok(used.has(f.id) || parents.has(f.id), `${tree} folder "${f.name}" is empty`);
    }
    const filed = items.filter((n) => n.meta.folder).length;
    assert.ok(filed / items.length >= 0.6, `only ${filed}/${items.length} ${tree} are in a folder`);
    assert.ok(filed < items.length, `every ${kind} is filed; a real tree has unsorted items too`);
  }
});

test('folders show the features: icon and colour, a team share and a client share', () => {
  assert.ok(gen.folders.every((f) => f.icon && f.color), 'every demo folder has an icon and a colour');
  assert.ok(new Set(gen.folders.map((f) => f.color)).size >= 4, 'use more than a few colours');
  assert.deepEqual([...new Set(gen.folders.map((f) => f.share).filter(Boolean))].sort(), ['client', 'team']);
  // Only these kinds can be shared on the brain (TREE_KIND_SPECS on main).
  for (const f of gen.folders.filter((x) => x.share)) assert.ok(['pages', 'notes'].includes(f.kind));
});

test('a page that used to be a parent sits NEXT TO its folder and lists it', () => {
  const pages = Object.fromEntries(gen.nodes.filter((n) => n.kind === 'page').map((p) => [p.id, p]));
  const byId = Object.fromEntries(gen.folders.map((f) => [f.id, f]));
  const indexPages = Object.values(pages).filter((p) => /\(folder:gen:/.test(p.body));
  assert.ok(indexPages.length >= 4, 'the handbook has four pages that were parents');
  for (const p of indexPages) {
    const target = byId[/\(folder:gen:([^)]+)\)/.exec(p.body)[1]];
    assert.equal(target.name, p.title, 'the folder carries the name of the page it came from');
    assert.equal(target.parent ?? null, p.meta.folder ?? null, `${p.id} must sit next to "${target.name}", not in it`);
    // The block must be a paragraph of its own, or it stays a plain link.
    assert.match(p.body, /\n\n\[Folder index\]\(folder:gen:[^)]+\)$/);
  }
  const here = Object.values(pages).filter((p) => p.body.endsWith('\n\n[Folder index](folder:here)'));
  assert.ok(here.length >= 1, 'no page shows the Folder index of its own folder');
  for (const p of here) assert.ok(p.meta.folder, `${p.id} lists "this folder" but sits at the top level`);
});

// ── Recall: a native map, not tagged pages ───────────────────────────────────
test('the Recall map is native: entry card, four cards, one prompt, no tagged pages', () => {
  assert.equal(gen.recall_maps.length, 1);
  const map = gen.recall_maps[0];
  assert.equal(map.cards.length, 4);
  assert.equal(map.entry.options.length, 4, 'the entry card leads to every card');
  const prompts = map.cards.filter((c) => c.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].use_when.length > 20 && prompts[0].body.length > 100);
  // Page-built maps were retired (migration 0209 deletes them): no page may
  // carry the old markers.
  const pages = gen.nodes.filter((n) => n.kind === 'page');
  assert.deepEqual(pages.filter((p) => p.tags.includes('recall') || p.tags.includes('prompt')).map((p) => p.id), []);
  assert.deepEqual(pages.filter((p) => p.meta?.recall_options || p.branch === 'studio.recall').map((p) => p.id), []);
});

test('Recall slugs are the ones the brain derives from the titles', () => {
  // recallSlug in packages/content-core/src/recall-compile.ts, restated: the
  // generator has no dependencies. A slug that differs would make the seeder
  // change it after the create and leave a former slug behind.
  const slug = (title) => title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  for (const map of gen.recall_maps) {
    assert.ok(map.title.length < 60 && map.cards.every((c) => c.title.length < 60), 'keep titles under the 60-character slug cut');
    assert.equal(map.slug, slug(map.title));
    for (const c of map.cards) assert.equal(c.slug, slug(c.title));
    // Sizes the brain caps: 6,000 characters of body, 500 per line, 200 per title.
    for (const c of [map.entry, ...map.cards]) assert.ok(c.body.length <= 6000);
    assert.ok(map.enter_when.length <= 500);
  }
});

test('tables carry formulas, aggregates, currency and select columns', () => {
  const types = new Set(gen.tables.flatMap((t) => t.columns.map((c) => c.type)));
  for (const t of ['formula', 'currency', 'select', 'number', 'text']) assert.ok(types.has(t), `no ${t} column anywhere`);
  assert.ok(gen.tables.filter((t) => t.columns.some((c) => c.type === 'formula')).length >= 2, 'need ≥2 tables with formulas');
  assert.ok(gen.tables.filter((t) => Object.keys(t.aggregates ?? {}).length).length >= 2, 'need ≥2 tables with aggregates');
});

test('files cover every ingest path with real magic bytes', () => {
  const kinds = new Set(gen.files.map((f) => f.kind));
  for (const k of ['pdf', 'png', 'xlsx', 'docx']) assert.ok(kinds.has(k), `no ${k} files`);
  const magic = { pdf: '%PDF', png: '\x89PNG', xlsx: 'PK\x03\x04', docx: 'PK\x03\x04' };
  for (const kind of Object.keys(magic)) {
    const buf = renderFile(gen.files.find((f) => f.kind === kind));
    assert.ok(buf.toString('latin1').startsWith(magic[kind]), `${kind} has wrong magic bytes`);
    assert.ok(buf.length > 100, `${kind} suspiciously small`);
  }
});

test('journals carry mood, and tasks carry status and priority', () => {
  const journals = gen.nodes.filter((n) => n.kind === 'journal');
  assert.ok(journals.every((j) => j.meta.mood), 'every journal needs a mood');
  const tasks = gen.nodes.filter((n) => n.kind === 'task');
  assert.ok(tasks.every((t) => t.meta.status && t.meta.priority), 'tasks need status + priority');
  const open = tasks.filter((t) => t.meta.status === 'open');
  assert.ok(open.length >= 15, `only ${open.length} open tasks`);
  assert.ok(open.filter((t) => t.meta.due_offset > 0).length >= 5, 'need tasks due in the future');
});

// ── Vocabulary spread: the reason search looks good ──────────────────────────
test('every vocabulary term appears across its declared type spread', () => {
  const corpus = { page: [], note: [], task: [], journal: [], email: [], table: [], event: [], chat: [] };
  for (const n of gen.nodes) if (corpus[n.kind]) corpus[n.kind].push(`${n.title}\n${n.body}`);
  for (const e of gen.emails) corpus.email.push(`${e.subject}\n${e.body}`);
  for (const t of gen.tables) corpus.table.push(`${t.title}\n${t.rows.flat().join(' ')}\n${t.columns.map((c) => c.name).join(' ')}`);
  for (const t of gen.turns) corpus.chat.push(t.prompt);

  const misses = [];
  for (const { term, spread } of world.vocabulary) {
    for (const type of spread) {
      const hay = (corpus[type] ?? []).join('\n').toLowerCase();
      if (!hay.includes(term.toLowerCase())) misses.push(`"${term}" missing from ${type}`);
    }
  }
  assert.deepEqual(misses, [], `vocabulary spread gaps:\n  ${misses.join('\n  ')}`);
});

test('cross-type search would return genuine multi-type hits', () => {
  // The v1 failure in miniature: a term that only lives in one type makes
  // search look empty. Every term must span ≥3 distinct types.
  for (const { term, spread } of world.vocabulary) {
    assert.ok(spread.length >= 3, `"${term}" spans only ${spread.length} type(s)`);
  }
});

// ── Turns ────────────────────────────────────────────────────────────────────
test('scripted turns exist and reference the world', () => {
  assert.ok(gen.turns.length >= 15, `only ${gen.turns.length} scripted turns`);
  const joined = gen.turns.map((t) => t.prompt).join(' ').toLowerCase();
  for (const probe of ['ps3', 'lathe', '214', 'island']) assert.ok(joined.includes(probe), `no turn mentions ${probe}`);
});

/**
 * Seed the demo brain from the generator's manifest.
 *
 * PRINCIPLE: create content through the REAL product paths, so the demo brain
 * is shaped by the same code a real one is. Concretely:
 *
 *   - bootstrap is the real signup → saveKey → provision → finish flow (the
 *     same one e2e/lib/bootstrap.ts drives), not a DB backdoor
 *   - content is created over the HTTP API — the same endpoints the UI calls
 *   - markdown → ProseMirror uses the app's own markdownToDoc
 *   - extraction (chunks, embeddings, facts, entities) is NOT done here: the
 *     nodes INSERT fires pg_notify('node_ingested') and server/api's durable
 *     extractor queue picks it up. We only wait for it to drain.
 *
 * Two things have no API and are done in SQL, deliberately and narrowly:
 *
 *   1. TIMESTAMPS. No create endpoint accepts a historical created_at, but a
 *      demo with no history is a demo with no story. The manifest carries
 *      day OFFSETS; we resolve them against seed time and backdate afterwards.
 *      Content, chunks, facts and entities still all come from real code.
 *   2. EMAILS. Mail normally arrives via IMAP; there is no create endpoint.
 *      We insert the node + emails row against a disabled demo mailbox, which
 *      is what the sync worker would have produced.
 *
 * Run it through demo/scripts/seed.sh — it brings the stack up, migrates, and
 * starts a server first. Direct use needs tsx and a running server:
 *   pnpm -C server/web exec tsx ../../demo/seed/seed.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { GenFolder, GenRecallMap, GenRecallOption, Manifest, Sql, TreeKind } from './lib/types.ts';
import { ownerPassword } from './lib/secrets.ts';
// The app's own markdown dialect — imported by relative path because the demo
// tree is not a workspace member (joining it would edit a main-owned file);
// each package still resolves its own deps from its own node_modules.
// Moved from packages/content to packages/content-core on main (db47fd61,
// "delete the content-core shims"); the seed followed it on 2026-09-17.
import { markdownToDoc } from '../../packages/content-core/src/markdown-to-doc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '..', 'generator', 'out', 'manifest.json');

const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = ownerPassword();
const FORCE = process.argv.includes('--force');

const DAY = 86_400_000;
const SEED_TIME = Date.now();
const at = (offsetDays: number) => new Date(SEED_TIME + offsetDays * DAY);
const iso = (offsetDays: number) => at(offsetDays).toISOString();

// ── Safety: this must never touch a real brain ──────────────────────────────
//
// The whole demo design rests on isolation, so the seeder refuses to run
// against anything it cannot positively identify as a demo database. Port
// 56432 is the demo stack's (see demo/docker-compose.yml); any other target
// must be both empty AND explicitly forced.
async function assertDemoDatabase(sql: Sql) {
  const isDemoPort = DB.includes(':56432/');
  const countRows = await sql`select count(*)::int as count from nodes`.catch(() => [{ count: 0 }]);
  const nodeCount = Number(countRows[0]?.count ?? 0);
  const marker = await sql`
    select 1 from pg_catalog.pg_description d
    join pg_catalog.pg_class c on c.oid = d.objoid
    where c.relname = 'nodes' and d.description = 'mantle-demo-brain'
  `.catch(() => []);
  const claimed = marker.length > 0;

  if (isDemoPort || claimed) return { fresh: nodeCount === 0 };
  if (nodeCount === 0 && FORCE) return { fresh: true };

  console.error(
    `\n✗ REFUSING TO SEED.\n` +
      `  Target: ${DB.replace(/:[^:@/]*@/, ':***@')}\n` +
      `  This is not the demo stack (port 56432) and carries no demo marker,` +
      ` and it holds ${nodeCount} nodes.\n` +
      `  Seeding writes content and REWRITES TIMESTAMPS — never point this at a real brain.\n` +
      `  If you are certain, use an empty database and pass --force.\n`,
  );
  process.exit(1);
}

// ── HTTP helpers (cookie session, exactly like the UI) ──────────────────────
let cookie = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return res;
}
async function post(path: string, body: unknown) {
  const res = await api(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}
/** Any verb, JSON in and out. A refusal is thrown with the brain's own words:
 *  the seed changes to fit the brain, never the reverse. */
async function send(method: 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const res = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json().catch(() => ({}));
}
async function get(path: string) {
  const res = await api(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ── Bootstrap: the real onboarding flow ─────────────────────────────────────
async function bootstrap() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!login.ok) {
    const signup = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    if (!signup.ok) throw new Error(`bootstrap: login ${login.status} and signup ${signup.status}`);
  }
  const shell = await (await api('/api/shell')).json();
  if (shell.onboarded === false) {
    // A REAL key: `finish` refuses a brain with no assistant, and `provision`
    // cannot make one from a placeholder (main v0.232.366). seed.sh stops
    // before this when there is none; a direct run gets the reason here.
    const key = process.env.DEMO_OPENROUTER_KEY;
    if (!key) throw new Error('bootstrap: DEMO_OPENROUTER_KEY is not set, and the brain will not finish onboarding without a working chat key');
    await post('/api/onboarding', { action: 'saveKey', service: 'openrouter', plaintext: key });
    await post('/api/onboarding', { action: 'provision' });
    const fin = await post('/api/onboarding', { action: 'finish' });
    if ((fin as { ok?: boolean }).ok !== true)
      throw new Error(`bootstrap: finish refused ${JSON.stringify(fin)}`);
  }
  console.log(`  owner ready: ${OWNER_EMAIL}`);
}

// ── Content creation ────────────────────────────────────────────────────────
const created = new Map<string, string>(); // manifest id → node id

/** Swap every `gen:<id>` reference in a body for the real id. The generator
 *  checked that each one names an item created earlier; a miss here means
 *  that item failed to seed, so stop rather than write a dead link. */
function resolveRefs(owner: string, body: string): string {
  return body.replace(/\((media|page|folder|draw|mention:node):gen:([A-Za-z0-9._-]+)\)/g, (_all, scheme: string, gen: string) => {
    const id = created.get(gen);
    if (!id) throw new Error(`${owner}: refers to ${gen}, which was not created`);
    return `(${scheme}:${id})`;
  });
}

// ── Folders (the item tree) ──────────────────────────────────────────────────
// One tree per kind, folders at most three deep, and an item is never a parent
// (docs/folder-tree.md). A folder that is already there (same name, same
// parent) is reused, so `seed.sh --keep` can run again without a name clash.
type TreeFolderRow = { id: string; name: string; share: string | null };
async function seedFolders(m: Manifest, kind: TreeKind) {
  const folders = (m.folders ?? []).filter((f) => f.kind === kind);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const emit = async (f: GenFolder): Promise<string> => {
    const have = created.get(f.id);
    if (have) return have;
    const parent = f.parent ? byId.get(f.parent) : null;
    if (f.parent && !parent) throw new Error(`folder ${f.id}: parent ${f.parent} is not in the manifest`);
    const parentId = parent ? await emit(parent) : null;
    const page = (await get(`/api/tree/${kind}${parentId ? `?folder=${parentId}` : ''}`)) as { folders?: TreeFolderRow[] };
    const existing = (page.folders ?? []).find((x) => x.name === f.name);
    let id = existing?.id;
    if (!id) {
      const r = (await post(`/api/tree/${kind}/folders`, {
        parentId,
        name: f.name,
        ...(f.icon ? { icon: f.icon } : {}),
        ...(f.color ? { color: f.color } : {}),
      })) as { folder?: { id?: string } };
      id = r.folder?.id;
    }
    if (!id) throw new Error(`folder ${f.id}: no id came back`);
    created.set(f.id, id);
    return id;
  };
  for (const f of folders) await emit(f);
  return folders.length;
}

/** File created items into their folders with the tree's own move, which is
 *  what dragging them in the UI does. `items` are [generator id, generator
 *  folder id or null]. One move per folder. */
async function fileInto(kind: TreeKind, items: Array<[string, string | null | undefined]>) {
  const byFolder = new Map<string, string[]>();
  for (const [gen, folderGen] of items) {
    if (!folderGen) continue;
    const folderId = created.get(folderGen);
    const id = created.get(gen);
    if (!folderId) throw new Error(`${gen}: folder ${folderGen} was not created`);
    if (!id) throw new Error(`${gen}: not created, so it cannot be filed`);
    byFolder.set(folderId, [...(byFolder.get(folderId) ?? []), id]);
  }
  for (const [folderId, ids] of byFolder) {
    const r = (await post(`/api/tree/${kind}/move`, { ids, folderId })) as { moved?: number; failed?: unknown[] };
    if (r.failed?.length) throw new Error(`filing ${kind}: ${JSON.stringify(r.failed).slice(0, 300)}`);
    // The route counts what it moved; anything less is an item left at the
    // top level with no error.
    if (r.moved !== ids.length) throw new Error(`filing ${kind}: sent ${ids.length} item(s), the brain moved ${r.moved}`);
  }
}
const nodesOf = (m: Manifest, kind: string) => m.nodes.filter((x) => x.kind === kind);
const placed = (list: Array<{ id: string; folder?: string | null; meta?: { folder?: string | null } }>) =>
  list.map((x): [string, string | null | undefined] => [x.id, x.meta?.folder ?? x.folder]);

async function seedContacts(m: Manifest) {
  await seedFolders(m, 'contacts');
  for (const n of nodesOf(m, 'contact')) {
    const [firstName, ...rest] = n.title.split(' ');
    const r = (await post('/api/contacts', {
      first_name: firstName,
      last_name: rest.join(' '),
      company: n.meta.company ?? undefined,
      emails: n.meta.emails,
      description: n.meta.role,
      tags: n.tags,
    })) as { contact?: { id?: string }; id?: string };
    const id = r.contact?.id ?? r.id;
    if (!id) throw new Error(`contact ${n.id}: no id came back`);
    created.set(n.id, id);
  }
  await fileInto('contacts', placed(nodesOf(m, 'contact')));
}

// Files go up as real multipart uploads, the same path the UI uses, so Tika
// and the image handling run for real.
async function seedFiles(m: Manifest) {
  await seedFolders(m, 'files');
  const dir = join(here, '..', 'generator', 'out', 'files');
  for (const f of m.files) {
    const form = new FormData();
    form.set('parentPath', 'files');
    form.set('file', new Blob([readFileSync(join(dir, f.name))]), f.name);
    const res = await fetch(`${SERVER}/api/files/files`, { method: 'POST', headers: cookie ? { cookie } : {}, body: form });
    if (!res.ok) throw new Error(`file upload ${f.name} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as { file?: { id?: string }; id?: string };
    const id = body.file?.id ?? body.id;
    if (!id) throw new Error(`file ${f.name}: no id came back`);
    created.set(f.id, id);
  }
  await fileInto('files', placed(m.files));
  return m.files.length;
}

async function seedTables(m: Manifest) {
  await seedFolders(m, 'tables');
  for (const t of m.tables) {
    const r = (await post('/api/tables', {
      title: t.title,
      tags: ['demo'],
      ...(t.icon ? { icon: t.icon } : {}),
      data: tableDocFromGen(t),
    })) as { table?: { id?: string }; id?: string };
    const id = r.table?.id ?? r.id;
    if (!id) throw new Error(`table ${t.id}: no id came back`);
    created.set(t.id, id);
  }
  await fileInto('tables', placed(m.tables));
}

// Draws: Excalidraw scenes. Create takes the scene; COMMIT gives the list its
// preview and the share page its picture, from the SVG an editor would export.
async function seedDraws(m: Manifest) {
  await seedFolders(m, 'draw');
  for (const d of m.draws ?? []) {
    const r = (await post('/api/draws', { title: d.title, scene: d.scene, tags: d.tags ?? ['demo'] })) as { draw?: { id?: string }; id?: string };
    const id = r.draw?.id ?? r.id;
    if (!id) throw new Error(`draw ${d.id}: no id came back`);
    created.set(d.id, id);
    const res = await api(`/api/draws/${id}/commit`, { method: 'POST', body: JSON.stringify({ scene: d.scene, svg: sceneToSvg(d.scene) }) });
    if (!res.ok) throw new Error(`draw ${d.id}: commit → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  await fileInto('draw', placed(m.draws ?? []));
  return (m.draws ?? []).length;
}

// Secrets and formulas: what make /secrets and /formulas a used brain.
async function seedOddments(m: Manifest) {
  await seedFolders(m, 'secrets');
  for (const n of nodesOf(m, 'secret')) {
    const r = (await post('/api/secrets', {
      title: n.title, description: n.body, kind: 'password', tags: n.tags,
      fields: [{ label: 'value', value: String(n.meta.value ?? 'demo-placeholder'), secret: true }],
    })) as { secret?: { id?: string }; id?: string };
    const id = r.secret?.id ?? r.id;
    if (!id) throw new Error(`secret ${n.id}: no id came back`);
    created.set(n.id, id);
  }
  await fileInto('secrets', placed(nodesOf(m, 'secret')));
  await seedFolders(m, 'formulas');
  for (const n of nodesOf(m, 'formula')) {
    const r = (await post('/api/formulas', { title: n.title, tags: n.tags, spec: n.meta.spec })) as { formula?: { id?: string }; id?: string };
    const id = r.formula?.id ?? r.id;
    if (!id) throw new Error(`formula ${n.id}: no id came back`);
    created.set(n.id, id);
  }
  await fileInto('formulas', placed(nodesOf(m, 'formula')));
}

// ── Apps: create, draft, build, publish, as an owner's Studio does ──────────
// The build type-checks and bundles the source, so a broken app fails HERE
// with the compiler's error rather than as an error card in front of a
// visitor. A re-run reuses an app of the same name.
function readSources(root: string, dir = root, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readSources(root, p, acc);
    else if (/\.(tsx?|css)$/.test(name)) acc[relative(root, p)] = readFileSync(p, 'utf8');
  }
  return acc;
}
async function seedApps(m: Manifest) {
  await seedFolders(m, 'apps');
  const list = (await get('/api/apps?limit=100')) as { apps?: Array<{ id: string; name: string }> };
  for (const a of m.apps ?? []) {
    const files = readSources(join(here, '..', 'apps', a.dir));
    if (!files[a.entry]) throw new Error(`app ${a.id}: entry ${a.entry} not found in demo/apps/${a.dir}`);
    let id = list.apps?.find((x) => x.name === a.name)?.id;
    if (!id) {
      const r = (await post('/api/apps', { name: a.name, description: a.description, icon: a.icon, tags: a.tags })) as { app?: { id?: string }; id?: string };
      id = r.app?.id ?? r.id;
    }
    if (!id) throw new Error(`app ${a.id}: no id came back`);
    created.set(a.id, id);
    await send('PUT', `/api/apps/${id}/draft`, { entry: a.entry, files });
    const build = await api(`/api/apps/${id}/build`, { method: 'POST' });
    const outcome = (await build.json().catch(() => ({}))) as { ok?: boolean; errors?: unknown[] };
    if (!build.ok || outcome.ok === false || (outcome.errors ?? []).length) {
      throw new Error(`app ${a.name}: build failed ${JSON.stringify(outcome.errors ?? outcome).slice(0, 400)}`);
    }
    const pub = await api(`/api/apps/${id}/publish`, { method: 'POST' });
    if (!pub.ok) throw new Error(`app ${a.name}: publish → ${pub.status} ${(await pub.text()).slice(0, 200)}`);
  }
  await fileInto('apps', placed(m.apps ?? []));
  return (m.apps ?? []).length;
}

// Pages: born in their folder (`POST /api/pages` takes `folderId`). A page's
// references are resolved first, so its images, cards and mentions point at
// real items from the start.
async function seedPages(m: Manifest) {
  await seedFolders(m, 'pages');
  for (const p of nodesOf(m, 'page')) {
    const folderGen = p.meta.folder;
    const r = (await post('/api/pages', {
      title: p.title,
      doc: markdownToDoc(resolveRefs(p.id, p.body)),
      tags: p.tags,
      folderId: folderGen ? created.get(folderGen) ?? null : null,
    })) as { page?: { id?: string }; id?: string };
    const id = r.page?.id ?? r.id;
    if (!id) throw new Error(`page ${p.id}: no id came back`);
    created.set(p.id, id);
  }
}

async function seedNotes(m: Manifest) {
  await seedFolders(m, 'notes');
  for (const n of nodesOf(m, 'note')) {
    const r = (await post('/api/notes', { title: n.title, content: resolveRefs(n.id, n.body), tags: n.tags })) as { note?: { id?: string } };
    if (!r.note?.id) throw new Error(`note ${n.id}: no id came back`);
    created.set(n.id, r.note.id);
  }
  await fileInto('notes', placed(nodesOf(m, 'note')));
}

async function seedDiary(m: Manifest) {
  for (const n of nodesOf(m, 'journal')) {
    const r = (await post('/api/journal', {
      title: n.title, body: n.body, mood: n.meta.mood, category: n.meta.category,
      entryDate: iso(n.offset).slice(0, 10), tags: n.tags,
    })) as { entry?: { id?: string }; journal?: { id?: string } };
    const id = r.entry?.id ?? r.journal?.id;
    if (!id) throw new Error(`journal ${n.id}: no id came back`);
    created.set(n.id, id);
  }
  await seedFolders(m, 'tasks');
  for (const n of nodesOf(m, 'task')) {
    const r = (await post('/api/tasks', {
      title: n.title, body: n.body, status: n.meta.status, priority: n.meta.priority,
      dueAt: n.meta.due_offset != null ? iso(n.meta.due_offset) : null, tags: n.tags,
    })) as { task?: { id?: string } };
    if (!r.task?.id) throw new Error(`task ${n.id}: no id came back`);
    created.set(n.id, r.task.id);
  }
  await fileInto('tasks', placed(nodesOf(m, 'task')));
  await seedFolders(m, 'events');
  for (const n of nodesOf(m, 'event')) {
    const start = n.meta.start_offset ?? n.offset;
    const r = (await post('/api/events', {
      title: n.title, body: n.body, startsAt: iso(start),
      endsAt: n.meta.duration_min ? new Date(at(start).getTime() + n.meta.duration_min * 60_000).toISOString() : null,
      location: n.meta.location || null, tags: n.tags,
    })) as { event?: { id?: string } };
    if (!r.event?.id) throw new Error(`event ${n.id}: no id came back`);
    created.set(n.id, r.event.id);
  }
  await fileInto('events', placed(nodesOf(m, 'event')));
}

/**
 * Share the folders the manifest marks, AFTER their items are filed, in the
 * manifest's order (Files first, so a page's images are already at the
 * page's level when the page folder is shared).
 *
 * A share that changes who can see items is refused first (409 `visibility`,
 * with the count) and goes ahead only when repeated with `confirm: true` and
 * the count that was shown. A person reads that list before confirming; the
 * seeder cannot read, so it COUNTS: the generator wrote on each shared folder
 * how many items the share must reach, and any other number is not confirmed.
 */
async function shareFolders(m: Manifest) {
  let n = 0;
  for (const f of (m.folders ?? []).filter((x) => x.share)) {
    const id = created.get(f.id);
    if (!id) continue; // its kind was not seeded on this run (DEMO_SEED_ONLY)
    const path = `/api/tree/${f.kind}/folders/${id}`;
    if (!f.expect) throw new Error(`share ${f.id}: the manifest carries no expected count for it (regenerate)`);
    const expected = f.expect.items + f.expect.folders;
    let res = await api(path, { method: 'PATCH', body: JSON.stringify({ share: f.share }) });
    if (res.status === 409) {
      const refusal = (await res.json().catch(() => ({}))) as { error?: string; total?: number; embedsTotal?: number };
      if (refusal.error !== 'visibility') throw new Error(`share ${f.id}: 409 ${JSON.stringify(refusal).slice(0, 200)}`);
      const seen = (refusal.total ?? 0) + (refusal.embedsTotal ?? 0);
      if (seen !== expected) {
        throw new Error(
          `share ${f.id} ("${f.name}" in ${f.kind} with ${f.share}): the brain says ${seen} row(s) would change ` +
            `(${refusal.total ?? 0} + ${refusal.embedsTotal ?? 0} through embeds), the generator expects ${expected}. ` +
            'NOT confirmed: something else would be published.',
        );
      }
      res = await api(path, { method: 'PATCH', body: JSON.stringify({ share: f.share, confirm: true, seen }) });
    }
    if (!res.ok) throw new Error(`share ${f.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`  ${f.kind} "${f.name}" shared with ${f.share === 'team' ? 'the team' : 'clients'}: ${expected} item(s)`);
    n++;
  }
  return n;
}

/** The public level: an open link on each item the generator marks public.
 *  A page's embeds go public with it (embedding means sharing); the brain
 *  lists them in `alsoLowered`, and they must be exactly the page's images. */
async function publicLinks(m: Manifest) {
  const items = [...m.nodes, ...m.tables, ...(m.draws ?? []), ...m.files, ...(m.apps ?? [])].filter((x) => x.public);
  const embedsOf = (body: string) => [...body.matchAll(/\(media:gen:([A-Za-z0-9._-]+)\)/g)].map((x) => x[1]!);
  let n = 0;
  for (const item of items) {
    const id = created.get(item.id);
    if (!id) continue;
    const r = (await post('/api/shares', { nodeId: id })) as { share?: { path?: string }; alsoLowered?: Array<{ id: string; title: string }> };
    if (!r.share?.path) throw new Error(`public link ${item.id}: no share came back`);
    const body = 'body' in item && typeof item.body === 'string' ? item.body : '';
    const want = embedsOf(body).map((g) => created.get(g)).filter((x): x is string => !!x);
    const got = (r.alsoLowered ?? []).map((x) => x.id);
    const stray = got.filter((g) => !want.includes(g));
    if (stray.length) throw new Error(`public link ${item.id}: the brain also lowered ${stray.length} item(s) the generator did not embed`);
    console.log(`  public link: ${'title' in item ? item.title : item.id}${got.length ? ` (+${got.length} embedded)` : ''}`);
    n++;
  }
  return n;
}

// ── Recall: a native map through the owner API ───────────────────────────────
// A map is a `recall` item plus card rows (docs/recall.md). Every write
// carries the map `version` it was made against and answers the next one, so
// the version is threaded through the whole build. Order matters:
//   1. the map (born published on the owner's surface, with its entry card)
//   2. the cards, without options: an option may only lead to a card that exists
//   3. the options, by card slug, entry card included
//   4. the prompt: an owner's `prompt: true` makes the card a prompt at once;
//      a card left waiting (`promptPending`) is confirmed through the owner's
//      confirm route, because a prompt serves only once it is confirmed
// Then the map is read back and checked, so a half-built map fails the seed
// here and not in front of an audience.
type RecallWrite = { version: number; cardSlug?: string; warnings?: Array<{ code: string; message: string }> };
type RecallCardRow = { slug: string; kind: string; promptPending: boolean; options: unknown[] };
type RecallMapRow = { id: string; slug: string; published: boolean; version: number; nodes?: RecallCardRow[] };

async function seedRecall(m: Manifest) {
  let n = 0;
  for (const map of m.recall_maps ?? []) {
    await seedRecallMap(map);
    n++;
  }
  return n;
}

async function seedRecallMap(map: GenRecallMap) {
  // A re-run replaces the map: a second create would only earn the slug a
  // `-2`, and agents remember slugs.
  const catalog = (await get(`/api/recall/maps?q=${encodeURIComponent(map.slug)}`)) as { maps?: RecallMapRow[] };
  for (const old of (catalog.maps ?? []).filter((x) => x.slug === map.slug)) {
    await send('DELETE', `/api/recall/maps/${old.id}`);
    console.log(`  replaced the existing map '${map.slug}'`);
  }

  const made = (await post('/api/recall/maps', { title: map.title, enterWhen: map.enter_when })) as {
    mapId?: string;
    slug?: string;
    version?: number;
  };
  if (!made.mapId || made.version === undefined) throw new Error(`recall ${map.slug}: the create answered no map id`);
  const base = `/api/recall/maps/${made.mapId}`;
  let version = made.version;
  // Every write answers the map's warnings as they stand after it. While the
  // map is being built they are expected (a card nothing leads to yet), so
  // only the LAST write's warnings are kept: what is left then is real.
  let warnings: NonNullable<RecallWrite['warnings']> = [];
  const step = (w: RecallWrite) => {
    version = w.version;
    warnings = w.warnings ?? [];
    return w;
  };
  if (made.slug !== map.slug) {
    step((await send('PATCH', base, { slug: map.slug, version })) as RecallWrite);
  }

  const opts = (list?: GenRecallOption[]) =>
    (list ?? []).map((o) => ({ label: o.label, useWhen: o.use_when, targetSlug: o.target }));

  for (const card of map.cards) {
    const w = step(
      (await post(`${base}/cards`, {
        title: card.title,
        bodyMd: card.body,
        ...(card.use_when ? { useWhen: card.use_when } : {}),
        ...(card.kind === 'prompt' ? { prompt: true } : {}),
        version,
      })) as RecallWrite,
    );
    if (w.cardSlug !== card.slug) {
      step((await send('PUT', `${base}/cards/${w.cardSlug}`, { title: card.title, bodyMd: card.body, slug: card.slug, version })) as RecallWrite);
    }
  }

  // Options, now that every target exists. The entry card's title is the map's.
  step((await send('PUT', `${base}/cards/start`, { title: map.title, bodyMd: map.entry.body, options: opts(map.entry.options), version })) as RecallWrite);
  for (const card of map.cards.filter((c) => c.options?.length)) {
    step((await send('PUT', `${base}/cards/${card.slug}`, { title: card.title, bodyMd: card.body, options: opts(card.options), version })) as RecallWrite);
  }

  const read = async () => ((await get(base)) as { map: RecallMapRow }).map;
  let live = await read();
  for (const card of map.cards.filter((c) => c.kind === 'prompt')) {
    const row = live.nodes?.find((x) => x.slug === card.slug);
    if (row?.kind === 'prompt' && !row.promptPending) continue;
    step((await post(`${base}/cards/${card.slug}/prompt`, { confirm: true, version })) as RecallWrite);
  }
  if (!live.published) step((await send('PATCH', base, { published: true, version })) as RecallWrite);

  live = await read();
  const problems: string[] = [];
  if (live.slug !== map.slug) problems.push(`slug is '${live.slug}'`);
  if (!live.published) problems.push('not published');
  if ((live.nodes?.length ?? 0) !== map.cards.length + 1) problems.push(`${live.nodes?.length} cards, wanted ${map.cards.length + 1}`);
  for (const card of [{ slug: 'start', kind: 'index', options: map.entry.options }, ...map.cards]) {
    const row = live.nodes?.find((x) => x.slug === card.slug);
    if (!row) problems.push(`card '${card.slug}' is missing`);
    else {
      if (row.kind !== card.kind) problems.push(`card '${card.slug}' is ${row.kind}, wanted ${card.kind}`);
      if (row.promptPending) problems.push(`card '${card.slug}' still waits for the owner's confirm`);
      if (row.options.length !== (card.options?.length ?? 0)) problems.push(`card '${card.slug}' has ${row.options.length} option(s), wanted ${card.options?.length ?? 0}`);
    }
  }
  // A warning left after the last write is a map a reader cannot walk fully
  // (a card nothing leads to, an entry card with no options).
  for (const warn of warnings) problems.push(`${warn.code}: ${warn.message}`);
  if (problems.length) throw new Error(`recall ${map.slug}: ${problems.join('; ')}`);
  created.set(map.id, made.mapId);
  console.log(`  map '${live.slug}': ${live.nodes?.length} cards, ${map.cards.filter((c) => c.kind === 'prompt').length} confirmed prompt(s), published, version ${live.version}`);
}

// Heartbeats: scheduled skill→agent triggers. Created through the real
// endpoint; `earliest_offset` is a day offset like every other date, so a
// fresh seed's heartbeats are always "due tomorrow", never overdue — and on
// the public demo (no worker) they never fire at all, which is honest: the
// screen shows configured automation, not a simulation of it.
async function seedHeartbeats(m: Manifest) {
  let n = 0;
  for (const h of m.heartbeats ?? []) {
    const res = await api('/api/heartbeats', {
      method: 'POST',
      body: JSON.stringify({
        slug: h.slug,
        name: h.name,
        agentSlug: h.agent,
        skillSlug: h.skill,
        schedule: h.schedule,
        surface: h.surface,
        description: h.description,
        quietHours: h.quiet_hours ?? null,
        cooldownMinutes: h.cooldown_minutes ?? null,
        minIdleMinutes: h.min_idle_minutes ?? null,
        earliestAt: h.earliest_offset != null ? iso(h.earliest_offset) : null,
      }),
    });
    if (!res.ok) throw new Error(`heartbeat ${h.slug}: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { heartbeat?: { id?: string } };
    if (r.heartbeat?.id) created.set(h.id, r.heartbeat.id);
    n++;
  }
  return n;
}

// Draws: Excalidraw scenes, through the real endpoints. Create takes the
// scene; COMMIT is what gives the list its preview, the share page its
// picture and the export its file, and it takes the SVG the committing editor
// exported. No editor commits on a seed run, so the snapshot is rendered here
// for the three element kinds the generator uses (rectangle, text, arrow) —
// plain shapes in the theme's neutral ink, which is what the preview is for.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function sceneToSvg(scene: { elements: unknown[] }): string {
  const els = scene.elements as Array<Record<string, unknown>>;
  const xs = els.map((e) => Number(e.x)), ys = els.map((e) => Number(e.y));
  const xe = els.map((e) => Number(e.x) + Number(e.width ?? 0)), ye = els.map((e) => Number(e.y) + Number(e.height ?? 0));
  const pad = 24;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xe) - minX + pad, h = Math.max(...ye) - minY + pad;
  const parts: string[] = [];
  for (const e of els) {
    const x = Number(e.x), y = Number(e.y), ew = Number(e.width ?? 0), eh = Number(e.height ?? 0);
    const stroke = String(e.strokeColor ?? '#1e1e1e');
    if (e.type === 'rectangle') {
      parts.push(`<rect x="${x}" y="${y}" width="${ew}" height="${eh}" rx="8" fill="none" stroke="${stroke}" stroke-width="2"/>`);
    } else if (e.type === 'text') {
      const size = Number(e.fontSize ?? 16);
      const lines = String(e.text ?? '').split('\n');
      const anchor = e.textAlign === 'center' ? 'middle' : 'start';
      const tx = e.textAlign === 'center' ? x + ew / 2 : x;
      const ty = e.verticalAlign === 'middle' ? y + eh / 2 - ((lines.length - 1) * size * 1.25) / 2 + size * 0.35 : y + size;
      parts.push(
        `<text x="${tx}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="${stroke}" text-anchor="${anchor}">` +
          lines.map((l, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : size * 1.25}">${esc(l)}</tspan>`).join('') +
          `</text>`,
      );
    } else if (e.type === 'arrow') {
      const pts = (e.points as number[][]) ?? [[0, 0], [ew, eh]];
      const abs = pts.map(([px, py]) => [x + px, y + py] as const);
      const d = abs.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" marker-end="url(#arrowhead)"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}">` +
    `<defs><marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#1e1e1e"/></marker></defs>` +
    `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#ffffff"/>` +
    parts.join('') +
    `</svg>`
  );
}

/** The option id the app itself would mint for a select label
 *  (`addSelectOption` in packages/content-core/src/table-model.ts). */
const optionId = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || randomUUID();

/**
 * Tables travel in the manifest as a GRID — column names, positional rows,
 * aggregates and views keyed by column NAME — because that is what a
 * generator can write by hand. The app stores a TableDoc: columns with ids,
 * rows as `{id, cells: {<columnId>: value}}`, select options as
 * `{id, label}` with the cell holding the option id, and aggregates/views
 * keyed by column id. Until 2026-09-17 the grid was POSTed as-is and
 * `ensureTableDoc` (tolerant by design) quietly kept every row with an empty
 * cells map: eleven tables with columns and no data, on the public demo, for
 * seven weeks. Build the document shape here, once, and the tolerant coercion
 * has nothing to forgive.
 */
function tableDocFromGen(t: Manifest['tables'][number]) {
  const columns = t.columns.map((c) => {
    const col: Record<string, unknown> = { id: randomUUID(), name: c.name, type: c.type };
    if (c.options) col.options = c.options.map((label) => ({ id: optionId(label), label }));
    if (c.formula) col.formula = c.formula;
    if (c.format) col.format = c.format;
    return col as { id: string; name: string; type: string; options?: Array<{ id: string; label: string }> };
  });
  const idOf = new Map(columns.map((c) => [c.name, c.id]));
  const rows = t.rows.map((values) => {
    const cells: Record<string, string | number | boolean | null> = {};
    columns.forEach((col, i) => {
      const v = values[i] ?? null;
      if (v === null || col.type === 'formula') return; // formula cells are derived on read
      if (col.type === 'select' && typeof v === 'string') {
        // The grid renders the stored value as-is (the option's id is for
        // identity and colour), so a select cell holds the LABEL, exactly as
        // the editor stores it when a person picks an option.
        cells[col.id] = v;
      } else if (col.type === 'date' && typeof v === 'number') {
        // Dates in a table are day OFFSETS like every other date in the
        // manifest, resolved against seed time so a fresh seed looks current.
        cells[col.id] = iso(v).slice(0, 10);
      } else {
        cells[col.id] = v;
      }
    });
    return { id: randomUUID(), cells };
  });
  const colId = (name: string): string => {
    const id = idOf.get(name);
    if (!id) throw new Error(`table "${t.title}": no column named "${name}"`);
    return id;
  };
  const aggregates = Object.fromEntries(
    Object.entries(t.aggregates ?? {}).map(([name, kind]) => [colId(name), kind]),
  );
  const views = (t.views ?? []).map((v) => ({
    id: randomUUID(),
    name: v.name,
    ...(v.sort ? { sort: v.sort.map((s) => ({ colId: colId(s.column), dir: s.dir })) } : {}),
    ...(v.filters
      ? {
          filters: v.filters.map((f) => ({
            colId: colId(f.column),
            op: f.op,
            ...(f.value !== undefined ? { value: f.value } : {}),
          })),
        }
      : {}),
  }));
  return { columns, rows, aggregates, views };
}

// Documentation is disk-backed, not a create endpoint: the generator already
// wrote the markdown under MANTLE_DOCS_ROOT, so this just registers the
// collection and lets the app index it in place. 'retrieval' depth is the
// honest setting for reference material — searchable, not memorised.
async function seedDocCollections(m: Manifest) {
  const collections = [...new Set(m.docs.map((d) => d.collection))];
  for (const key of collections) {
    const res = await api('/api/docs/collections', {
      method: 'POST',
      body: JSON.stringify({
        key,
        label: key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        rootPath: key,
        brainDepth: 'retrieval',
        origin: 'demo',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (body.ok === false) console.log(`  (${key}: ${body.message})`);
  }
  return collections.length;
}

// ── Emails: no API exists (mail arrives by IMAP), so this writes what the
// sync worker would have written, against a DISABLED demo mailbox that can
// never actually connect anywhere.
async function seedEmails(sql: Sql, m: Manifest, ownerId: string) {
  const accountRows = await sql`
    insert into email_accounts (user_id, provider, address, display_name, branch_path, enabled, imap_host, imap_port)
    values (${ownerId}, 'imap', ${OWNER_EMAIL}, 'Demo mailbox', 'email', false, 'imap.example.com', 993)
    returning id
  `;
  const accountId = accountRows[0]?.id;
  let n = 0;
  for (const e of m.emails) {
    const sentAt = at(e.offset);
    const nodeRows = await sql`
      insert into nodes (owner_id, type, title, path, tags, data, created_at, updated_at)
      values (${ownerId}, 'email', ${e.subject.slice(0, 200)}, 'email', ${sql.array(['demo'])},
              ${sql.json({ from: e.from, to: e.to, thread: e.thread, body: e.body })},
              ${sentAt}, ${sentAt})
      returning id
    `;
    const nodeId = nodeRows[0]?.id;
    await sql`
      insert into emails (
        node_id, account_id, provider_msg_id, rfc_message_id, thread_id,
        from_addr, to_addrs, cc_addrs, subject, snippet, body_text,
        internal_date, folder, is_read, delivery_kind
      )
      values (
        ${nodeId}, ${accountId}, ${e.id}, ${`<${e.id}@harbourlabs.example.com>`}, ${e.thread},
        ${e.from}, ${sql.array(e.to)}, ${sql.array(e.cc ?? [])},
        ${e.subject}, ${e.body.slice(0, 200)}, ${e.body},
        ${sentAt}, 'INBOX', true, 'direct'
      )
      on conflict do nothing
    `;
    n++;
  }
  return n;
}

/** A spreadsheet upload makes a table of its own (the xlsx import path), after
 *  extraction, with the file name as its title, at the top of Tables. That
 *  is a real feature worth showing, so the import is kept: it gets a readable
 *  title and goes into the Private folder. Waits for it, at most two minutes. */
async function tidyImports(sql: Sql, m: Manifest) {
  const xlsx = m.files.filter((f) => f.kind === 'xlsx');
  const folder = created.get('fld-tables-private');
  if (!xlsx.length || !folder) return 0;
  const deadline = Date.now() + 120_000;
  let rows: Array<{ id: unknown; source: unknown }> = [];
  while (Date.now() < deadline) {
    rows = (await sql`select id, data->>'sourceFileId' as source from nodes where type = 'table' and data ? 'sourceFileId'`) as Array<{ id: unknown; source: unknown }>;
    if (rows.length >= xlsx.length) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  for (const row of rows) {
    const file = xlsx.find((f) => created.get(f.id) === String(row.source));
    if (!file) continue;
    await send('PATCH', `/api/tables/${String(row.id)}`, { title: `${file.title} (imported from the xlsx)` });
    const r = (await post('/api/tree/tables/move', { ids: [String(row.id)], folderId: folder })) as { moved?: number };
    if (r.moved !== 1) throw new Error(`imported table ${String(row.id)}: not filed`);
  }
  return rows.length;
}

// ── Backdating: the manifest's offsets become the brain's history ───────────
async function backdate(sql: Sql, m: Manifest) {
  const rows: Array<[string, string]> = [];
  // A Recall map's tree item is a node too (its id is the map's id).
  for (const n of [...m.nodes, ...m.tables, ...m.files, ...(m.draws ?? []), ...(m.apps ?? []), ...(m.recall_maps ?? [])]) {
    const id = created.get(n.id);
    if (id) rows.push([id, at(n.offset).toISOString()]);
  }
  for (const [id, ts] of rows) {
    await sql`update nodes set created_at = ${ts}, updated_at = ${ts} where id = ${id}::uuid`;
  }
  return rows.length;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;

  console.log(`\ndemo seeder: manifest seed ${manifest.seed}\n  server ${SERVER}\n  db     ${DB.replace(/:[^:@/]*@/, ':***@')}\n`);
  await assertDemoDatabase(sql);

  console.log('· bootstrap');
  await bootstrap();

  const ownerRows = await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`;
  const ownerId = ownerRows[0]?.id;
  if (!ownerId) throw new Error('seed: owner row not found after bootstrap');

  // DEMO_SEED_ONLY=recall,heartbeats: seed just those kinds into an EXISTING
  // brain (`seed.sh --keep`). Only the kinds nothing else refers to can be
  // seeded alone; pages and notes need the files, tables and drawings they
  // point at, so they come with the full seed.
  const ALONE = ['recall', 'heartbeats', 'docs', 'emails'];
  const only = new Set((process.env.DEMO_SEED_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const k of only) if (!ALONE.includes(k)) throw new Error(`DEMO_SEED_ONLY: '${k}' cannot be seeded alone (only ${ALONE.join(', ')})`);
  const all = only.size === 0;
  const want = (kind: string) => all || only.has(kind);
  if (!all) console.log(`· DEMO_SEED_ONLY: ${[...only].join(', ')}`);

  if (all) {
    // The order is the generator's CREATE_ORDER: a page or note may refer to
    // anything created before it, never after.
    console.log('· contacts');                        await seedContacts(manifest);
    console.log(`· files: ${await seedFiles(manifest)} uploaded (real multipart, Tika runs for real)`);
    console.log('· tables');                          await seedTables(manifest);
    console.log(`· draws: ${await seedDraws(manifest)}`);
    console.log('· secrets, formulas');               await seedOddments(manifest);
    console.log(`· apps: ${await seedApps(manifest)} built and published`);
    console.log('· pages (in their folders, references resolved)'); await seedPages(manifest);
    console.log('· notes');                           await seedNotes(manifest);
    console.log('· journal, tasks, events');          await seedDiary(manifest);
    console.log('· folder shares (team and client)');
    console.log(`  ${await shareFolders(manifest)} shared`);
    console.log('· public links');
    console.log(`  ${await publicLinks(manifest)} made`);
  }
  if (want('recall')) { console.log('· Recall: the native maps, through the owner API'); await seedRecall(manifest); }
  if (want('heartbeats')) console.log(`· heartbeats: ${await seedHeartbeats(manifest)}`);
  if (want('docs')) {
    console.log('· documentation collections (disk-backed, indexed in place)');
    console.log(`  ${await seedDocCollections(manifest)} registered`);
  }
  let mails = 0;
  if (want('emails')) {
    console.log('· emails (no API: written as the sync worker would)');
    mails = await seedEmails(sql, manifest, String(ownerId));
  }
  if (all) console.log(`· imported tables tidied: ${await tidyImports(sql, manifest)}`);
  console.log('· backdating the timeline');
  const dated = await backdate(sql, manifest);

  // Mark the database so the safety guard recognises it next run.
  await sql`comment on table nodes is 'mantle-demo-brain'`;

  const counts = await sql`select type, count(*)::int as n from nodes group by type order by n desc`;
  console.log('\nnodes in the brain:');
  for (const r of counts) console.log(`  ${String(r.type).padEnd(16)}${r.n}`);
  console.log(`\n✓ seeded: ${dated} nodes backdated, ${mails} emails, seed time ${new Date(SEED_TIME).toISOString()}`);
  console.log('  extraction runs asynchronously in server/api; drain.sh waits for it and asserts.\n');
  await sql.end();
}

main().catch((err) => {
  console.error('\n✗ seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

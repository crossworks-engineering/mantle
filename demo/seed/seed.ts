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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { GenNode, Manifest, Sql } from './lib/types.ts';
// The app's own markdown dialect — imported by relative path because the demo
// tree is not a workspace member (joining it would edit a main-owned file);
// each package still resolves its own deps from its own node_modules.
import { markdownToDoc } from '../../packages/content/src/markdown-to-doc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '..', 'generator', 'out', 'manifest.json');

const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';
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
    // A real key is only needed for P4 (scripted turns). Extraction needs a
    // working chat model too — DEMO_OPENROUTER_KEY supplies one when present.
    await post('/api/onboarding', {
      action: 'saveKey',
      service: 'openrouter',
      plaintext: process.env.DEMO_OPENROUTER_KEY ?? 'sk-or-v1-demo-placeholder-key-not-used',
    });
    await post('/api/onboarding', { action: 'provision' });
    const fin = await post('/api/onboarding', { action: 'finish' });
    if ((fin as { ok?: boolean }).ok !== true)
      throw new Error(`bootstrap: finish refused ${JSON.stringify(fin)}`);
  }
  console.log(`  owner ready: ${OWNER_EMAIL}`);
}

// ── Content creation ────────────────────────────────────────────────────────
const created = new Map<string, string>(); // manifest id → node id

async function seedContacts(m: Manifest) {
  for (const n of m.nodes.filter((x) => x.kind === 'contact')) {
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
    if (id) created.set(n.id, id);
  }
}

async function seedSimple(m: Manifest) {
  for (const n of m.nodes.filter((x) => x.kind === 'note')) {
    const r = (await post('/api/notes', {
      title: n.title, content: n.body, tags: n.tags,
    })) as { note?: { id?: string } };
    if (r.note?.id) created.set(n.id, r.note.id);
  }
  for (const n of m.nodes.filter((x) => x.kind === 'journal')) {
    const r = (await post('/api/journal', {
      title: n.title,
      body: n.body,
      mood: n.meta.mood,
      category: n.meta.category,
      entryDate: iso(n.offset).slice(0, 10),
      tags: n.tags,
    })) as { entry?: { id?: string }; journal?: { id?: string } };
    const jid = r.entry?.id ?? r.journal?.id;
    if (jid) created.set(n.id, jid);
  }
  for (const n of m.nodes.filter((x) => x.kind === 'task')) {
    const r = (await post('/api/tasks', {
      title: n.title,
      body: n.body,
      status: n.meta.status,
      priority: n.meta.priority,
      dueAt: n.meta.due_offset != null ? iso(n.meta.due_offset) : null,
      tags: n.tags,
    })) as { task?: { id?: string } };
    if (r.task?.id) created.set(n.id, r.task.id);
  }
  for (const n of m.nodes.filter((x) => x.kind === 'event')) {
    const start = n.meta.start_offset ?? n.offset;
    const r = (await post('/api/events', {
      title: n.title,
      body: n.body,
      startsAt: iso(start),
      endsAt: n.meta.duration_min ? new Date(at(start).getTime() + n.meta.duration_min * 60_000).toISOString() : null,
      location: n.meta.location || null,
      tags: n.tags,
    })) as { event?: { id?: string } };
    if (r.event?.id) created.set(n.id, r.event.id);
  }
}

// Pages must be created parents-first so parentId resolves and the ltree
// sub-page tree actually forms.
async function seedPages(m: Manifest) {
  const pages = m.nodes.filter((x) => x.kind === 'page');
  const byId = new Map(pages.map((p) => [p.id, p]));
  const done = new Set<string>();
  const emit = async (p: GenNode): Promise<void> => {
    if (done.has(p.id)) return;
    const parent = p.meta?.parent_id ? byId.get(p.meta.parent_id) : null;
    if (parent) await emit(parent);
    const r = (await post('/api/pages', {
      title: p.title,
      doc: markdownToDoc(p.body),
      tags: p.tags,
      ...(p.meta?.parent_id && created.has(p.meta.parent_id)
        ? { parentId: created.get(p.meta.parent_id) }
        : {}),
    })) as { page?: { id?: string }; id?: string };
    const id = r.page?.id ?? r.id;
    if (id) created.set(p.id, id);
    done.add(p.id);
  };
  for (const p of pages) await emit(p);
}

async function seedTables(m: Manifest) {
  for (const t of m.tables) {
    const r = (await post('/api/tables', {
      title: t.title,
      tags: ['demo'],
      data: {
        columns: t.columns,
        rows: t.rows,
        aggregates: t.aggregates ?? {},
      },
    })) as { table?: { id?: string }; id?: string };
    const id = r.table?.id ?? r.id;
    if (id) created.set(t.id, id);
  }
}

// Secrets and formulas: small, but they are what make /secrets and /formulas
// render as a used brain rather than an empty state.
async function seedOddments(m: Manifest) {
  for (const n of m.nodes.filter((x) => x.kind === 'secret')) {
    const r = (await post('/api/secrets', {
      title: n.title,
      description: n.body,
      kind: 'password',
      tags: n.tags,
      fields: [{ label: 'value', value: String(n.meta.value ?? 'demo-placeholder'), secret: true }],
    })) as { secret?: { id?: string }; id?: string };
    const id = r.secret?.id ?? r.id;
    if (id) created.set(n.id, id);
  }
  for (const n of m.nodes.filter((x) => x.kind === 'formula')) {
    const r = (await post('/api/formulas', {
      title: n.title,
      tags: n.tags,
      spec: n.meta.spec,
    })) as { formula?: { id?: string }; id?: string };
    const id = r.formula?.id ?? r.id;
    if (id) created.set(n.id, id);
  }
}

// Files go up as real multipart uploads — the same path the UI uses — so Tika
// and the image handling run for real. The bytes come from the generator, not
// from stubs, which is why that mattered.
async function seedFiles(m: Manifest) {
  const dir = join(here, '..', 'generator', 'out', 'files');
  let ok = 0;
  for (const f of m.files) {
    const form = new FormData();
    form.set('parentPath', 'files');
    form.set('file', new Blob([readFileSync(join(dir, f.name))]), f.name);
    const res = await fetch(`${SERVER}/api/files/files`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      body: form,
    });
    if (!res.ok) {
      if (ok === 0) throw new Error(`file upload ${f.name} → ${res.status} ${(await res.text()).slice(0, 160)}`);
      continue; // a later straggler shouldn't discard a good run
    }
    const body = (await res.json().catch(() => ({}))) as { file?: { id?: string }; id?: string };
    const id = body.file?.id ?? body.id;
    if (id) created.set(f.id, id);
    ok++;
  }
  return ok;
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

// ── Backdating: the manifest's offsets become the brain's history ───────────
async function backdate(sql: Sql, m: Manifest) {
  const rows: Array<[string, string]> = [];
  for (const n of [...m.nodes, ...m.tables, ...m.files]) {
    const id = created.get(n.id);
    if (id) rows.push([id, at(n.offset).toISOString()]);
  }
  let n = 0;
  for (const [id, ts] of rows) {
    await sql`update nodes set created_at = ${ts}, updated_at = ${ts} where id = ${id}::uuid`;
    n++;
  }
  return n;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;

  console.log(`\ndemo seeder — manifest seed ${manifest.seed}\n  server ${SERVER}\n  db     ${DB.replace(/:[^:@/]*@/, ':***@')}\n`);
  await assertDemoDatabase(sql);

  console.log('· bootstrap');
  await bootstrap();

  const ownerRows = await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`;
  const ownerId = ownerRows[0]?.id;
  if (!ownerId) throw new Error('seed: owner row not found after bootstrap');

  console.log('· contacts');   await seedContacts(manifest);
  console.log('· notes, journals, tasks, events'); await seedSimple(manifest);
  console.log('· pages (parents first)'); await seedPages(manifest);
  console.log('· tables');     await seedTables(manifest);
  console.log('· secrets, formulas'); await seedOddments(manifest);
  console.log('· documentation collections (disk-backed, indexed in place)');
  const cols = await seedDocCollections(manifest);
  console.log(`  ${cols} registered`);
  console.log('· files (real multipart uploads → Tika runs for real)');
  const files = await seedFiles(manifest);
  console.log(`  ${files}/${manifest.files.length} uploaded`);
  console.log('· emails (no API — written as the sync worker would)');
  const mails = await seedEmails(sql, manifest, String(ownerId));
  console.log('· backdating the timeline');
  const dated = await backdate(sql, manifest);

  // Mark the database so the safety guard recognises it next run.
  await sql`comment on table nodes is 'mantle-demo-brain'`;

  const counts = await sql`select type, count(*)::int as n from nodes group by type order by n desc`;
  console.log('\nnodes in the brain:');
  for (const r of counts) console.log(`  ${String(r.type).padEnd(16)}${r.n}`);
  console.log(`\n✓ seeded — ${dated} nodes backdated, ${mails} emails, seed time ${new Date(SEED_TIME).toISOString()}`);
  console.log('  extraction runs asynchronously in server/api; use demo/seed/verify.ts to wait and assert.\n');
  await sql.end();
}

main().catch((err) => {
  console.error('\n✗ seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

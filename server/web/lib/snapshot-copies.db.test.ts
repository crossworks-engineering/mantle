/**
 * Workspaces W6b (plan S3): the author's read-only snapshot copies of its
 * accepted items. A scratch brain is migrated up to the spaces fold (0267),
 * switched onto workspaces, and given a member's accepted page and note
 * whose accepted versions name an Admin-only item, plus an accepted page
 * whose author is gone; then 0267 and every later migration run, and the
 * copies are made. Checked: a dry run writes nothing; each copy is a new
 * item in the author's private (or Former user) workspace, its only grant
 * with Write off, marked snapshot_of and extract_skipped, redacted (the
 * Admin-only item's id is not in it); no extractor notify and the extract
 * queue unchanged; the accepted space_items rows are archived away; a
 * second run makes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/snapshot-copies.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const FOLD = '0267_workspaces_spaces_fold';

describe.skipIf(!URL)('the authors’ snapshot copies of accepted items (W6b, S3)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>>;
  let sql: ReturnType<typeof postgres>;
  let listener: ReturnType<typeof postgres>;
  let sc: typeof import('./snapshot-copies');
  let m: typeof import('@mantle/db');
  let dir = '';
  const notified: string[] = [];
  const owner = randomUUID();
  const member = randomUUID();
  const gone = randomUUID();
  const secret = randomUUID(); // an Admin-only page the accepted items name
  const page = randomUUID();
  const note = randomUUID();
  const orphan = randomUUID();
  const since = new Date(Date.now() - 86_400_000);
  let queueBefore = 0;

  const mention = (id: string) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          { type: 'mention', attrs: { id, label: 'Board minutes', kind: 'page' } },
        ],
      },
    ],
  });
  const accepted = async (id: string, type: 'page' | 'note', author: string) => {
    await sql`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, ${type}::node_type, ${`accepted ${type}`}, ${`${type}s`}::ltree,
              ${sql.json(type === 'note' ? { content: `see [minutes](/n/${secret})` } : {})})`;
    if (type === 'page') {
      await sql`insert into pages (node_id, doc) values (${id}, ${sql.json(mention(secret) as never)})`;
    }
    await sql`insert into space_items (node_id, author_login_id, sharing, review_state,
        reviewed_by, reviewed_at, accepted_at)
      values (${id}, ${author}, 'private', 'accepted', ${owner}, now(), now())`;
  };
  const copyOf = async (id: string) =>
    (
      await sql<{ copy: string | null; home: string }[]>`
        select snapshot_node_id::text as copy, home_workspace_id::text as home
          from space_item_homes where node_id = ${id}`
    )[0]!;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createScratchDatabaseBefore(URL!, FOLD);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-copies-'));
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.FILES_DIR = path.join(dir, 'files');
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'sc-o@example.invalid', 'x', 'admin', true, null),
      (${member}, 'sc-m@example.invalid', 'x', 'member', false, 'Member One'),
      (${gone}, 'sc-g@example.invalid', 'x', 'member', false, null)`;
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${secret}, ${owner}, 'page', 'Board minutes', 'pages')`;
    await accepted(page, 'page', member);
    await accepted(note, 'note', member);
    await accepted(orphan, 'page', gone);
    // Archived with its author still there, then the author is deleted.
    await sql`select * from mantle_ws_review_off()`;
    await sql`delete from auth.users where id = ${gone}`;

    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    await scratch.migrateRest();
    m = await import('@mantle/db');
    sc = await import('./snapshot-copies');
    queueBefore = (
      await m.db
        .select({ id: m.nodes.id })
        .from(m.nodes)
        .where(m.unextractedNodeConds(owner, since))
    ).length;
    listener = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await listener.listen('node_ingested', (p) => notified.push(p));
  }, 240_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('a dry run counts and writes nothing', async () => {
    const r = await sc.makeSnapshotCopies({ dryRun: true });
    expect(r).toMatchObject({ wanted: 3, made: 0, already: 0, acceptedRowsCleared: 0 });
    expect(r.skipped).toEqual({ 'dry run: to make': 3 });
    expect((await copyOf(page)).copy).toBeNull();
  });

  it('makes each copy in the author’s home, redacted, read-only, quiet, then clears the accepted rows', async () => {
    // Two runs at once (the boot step and the maintenance task, fix round
    // 1, M4): one makes the copies, the other waits and finds them made.
    const [r1, r2] = await Promise.all([sc.makeSnapshotCopies(), sc.makeSnapshotCopies()]);
    const r = r1.made > 0 ? r1 : r2;
    const other = r === r1 ? r2 : r1;
    expect(other).toMatchObject({ made: 0, already: 3 });
    for (const id of [page, note, orphan]) {
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from nodes where data->>'snapshot_of' = ${id}`;
      expect(n!.n).toBe(1);
    }
    expect(r).toMatchObject({
      wanted: 3,
      made: 3,
      already: 0,
      skipped: {},
      acceptedRowsCleared: 3,
    });
    const priv = (
      await sql<{ ws: string }[]>`select workspace_id::text as ws from private_workspaces
        where login_id = ${member}`
    )[0]!.ws;
    const former = (
      await sql<{ ws: string }[]>`select workspace_id::text as ws from former_user_workspaces
        where former_key = ${gone}`
    )[0]!.ws;
    for (const [id, home] of [
      [page, priv],
      [note, priv],
      [orphan, former],
    ] as const) {
      const { copy, home: recorded } = await copyOf(id);
      expect(recorded).toBe(home);
      expect(copy).toBeTruthy();
      const [c] = await sql<
        {
          home: string;
          read: string[];
          write: string[];
          data: Record<string, unknown>;
          owner: string;
        }[]
      >`select home_ws::text as home, read_ws::text[] as read, write_ws::text[] as write, data,
               owner_id::text as owner from nodes where id = ${copy}`;
      expect(c).toMatchObject({ home, read: [home], write: [], owner });
      expect(c!.data.snapshot_of).toBe(id);
      expect((c!.data.extract_skipped as { reason: string }).reason).toBe('snapshot_copy');
    }
    // Redacted: the Admin-only page's id is in none of the copies.
    const pageCopy = (await copyOf(page)).copy!;
    const [doc] = await sql<{ doc: unknown }[]>`select doc from pages where node_id = ${pageCopy}`;
    expect(JSON.stringify(doc!.doc)).not.toContain(secret);
    expect(JSON.stringify(doc!.doc)).toContain('see ');
    const noteCopy = (await copyOf(note)).copy!;
    const [n] = await sql<
      { data: { content?: string } }[]
    >`select data from nodes where id = ${noteCopy}`;
    expect(n!.data.content ?? '').not.toContain(secret);
    // No notify, no queue row.
    await new Promise((res) => setTimeout(res, 300));
    expect(notified).toEqual([]);
    expect(
      (
        await m.db
          .select({ id: m.nodes.id })
          .from(m.nodes)
          .where(m.unextractedNodeConds(owner, since))
      ).length,
    ).toBe(queueBefore);
    // The accepted rows are gone, archived.
    const [left] = await sql<{ n: number }[]>`
      select count(*)::int as n from space_items where review_state = 'accepted'`;
    expect(left!.n).toBe(0);
    const [arch] = await sql<{ n: number }[]>`
      select count(*)::int as n from archive_space_items
       where node_id = any(${[page, note, orphan]}::uuid[]) and review_state = 'accepted'`;
    expect(arch!.n).toBe(3);
    const check = Object.fromEntries(
      (await sql<{ metric: string; n: string }[]>`select * from mantle_ws_spaces_fold_check()`).map(
        (r) => [r.metric, Number(r.n)],
      ),
    );
    expect(check['snapshot copies wanted']).toBe(3);
    expect(check['snapshot copies made']).toBe(3);
  });

  it('a second run makes nothing; a lost record is found again by its stamp', async () => {
    const before = (await copyOf(page)).copy;
    await sql`update space_item_homes set snapshot_node_id = null where node_id = ${page}`;
    const r = await sc.makeSnapshotCopies();
    expect(r).toMatchObject({ wanted: 3, made: 0, already: 3, acceptedRowsCleared: 0 });
    expect((await copyOf(page)).copy).toBe(before);
  });

  it('a copy is read only in the database, for everyone (CEO decision 2)', async () => {
    const pageCopy = (await copyOf(page)).copy!;
    const noteCopy = (await copyOf(note)).copy!;
    const team = (
      await sql<
        { id: string }[]
      >`select id::text as id from workspaces where name = 'Team' and not is_admin`
    )[0]!.id;
    const refused = async (q: PromiseLike<unknown>) => {
      await expect(Promise.resolve(q)).rejects.toMatchObject({ code: '42501' });
    };
    await refused(sql`update nodes set title = 'changed' where id = ${noteCopy}`);
    await refused(sql`update nodes set data = data - 'snapshot_of' where id = ${noteCopy}`);
    await refused(
      sql`update pages set doc = '{"type":"doc","content":[]}'::jsonb where node_id = ${pageCopy}`,
    );
    await refused(sql`update pages set draft_doc = doc where node_id = ${pageCopy}`);
    await refused(
      sql`insert into item_grants (node_id, workspace_id) values (${pageCopy}, ${team})`,
    );
    await refused(sql`update item_grants set write = true where node_id = ${pageCopy}`);
    // The extractor's bookkeeping may change; a delete is its author's.
    await sql`update nodes set data = data || '{"summary":"s"}'::jsonb where id = ${noteCopy}`;
    await sql`delete from nodes where id = ${noteCopy}`;
  });
});

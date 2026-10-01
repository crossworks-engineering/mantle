/**
 * Migration 0212 on a real Postgres: a brain that was restored without the
 * folder share refresh trigger gets it back, and the levels that went stale
 * while it was gone are repaired (restore rehearsal, 2026-10-01).
 *
 * A restore of a dump taken at migration 0204 up to 0210 lost
 * nodes_share_refresh_after (dump-restore.db.test.ts shows why). From then
 * on a folder share, unshare, move or rename no longer reached the rows
 * below the folder. This puts a scratch database in that state (the trigger
 * dropped by hand), changes shares, and runs 0212's statements: every
 * inherited level is what 0204's rule gives again, an unshare that had
 * failed OPEN is closed, what a repaired row embeds follows it (0208), the
 * trigger is back and works, and a second run writes nothing. On a brain
 * that never lost the trigger the migration writes no row at all: files,
 * notes, pages, a task and a member's own rows are all left as they are.
 *
 * Runs on a scratch database of its own (migrated from scratch, dropped
 * after): it drops a trigger on nodes, and the migration walks every owner.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/share-refresh-restored.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIGRATION = join(__dirname, '..', 'migrations', '0212_restorable_share_refresh_trigger.sql');

const statements = () =>
  readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

describe.skipIf(!URL)('migration 0212: the share refresh trigger and the levels it kept', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let brain = '';
  let space = '';
  const member = randomUUID();
  const id = {
    open: randomUUID(), // files folder, shared with the team before the trigger went
    openFile: randomUUID(),
    sub: randomUUID(), // a folder inside it
    subFile: randomUUID(),
    closed: randomUUID(), // files folder, not shared before the trigger went
    closedFile: randomUUID(),
    quiet: randomUUID(), // files folder shared with clients, never touched
    quietFile: randomUUID(),
    notes: randomUUID(), // notes folder, shared with the team before the trigger went
    note: randomUUID(), // a note in it that embeds `pic`
    pic: randomUUID(), // a file outside every shared folder
    docs: randomUUID(), // pages folder shared with clients, never touched
    page: randomUUID(),
    task: randomUUID(), // never a workspace kind: never inherits
    mine: randomUUID(), // a member's own folder and note (another owner)
    mineNote: randomUUID(),
  };

  /** The migration as migrate.ts runs it: every statement in one transaction. */
  const migrate = () =>
    sql.begin(async (tx) => {
      for (const stmt of statements()) await tx.unsafe(stmt);
    });
  const row = async (nodeId: string) => {
    const [r] = await sql<{ inherited_level: string | null; embedded_level: string | null }[]>`
      select inherited_level, embedded_level from nodes where id = ${nodeId}`;
    return r!;
  };
  const level = async (nodeId: string) => (await row(nodeId)).inherited_level;
  const share = (folder: string, to: 'team' | 'client' | null) =>
    sql`update nodes set share_level = ${to} where id = ${folder}`;
  const hasTrigger = async () =>
    (
      await sql`
        select 1 from pg_trigger
         where tgname = 'nodes_share_refresh_after' and tgrelid = 'public.nodes'::regclass`
    ).length === 1;
  /** A row version per node, every owner: any write to a row changes its xmin. */
  const versions = async () =>
    Object.fromEntries(
      (await sql<{ id: string; v: string }[]>`select id, xmin::text as v from nodes`).map((r) => [
        r.id,
        r.v,
      ]),
    );
  const drifted = async () => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from nodes
       where inherited_level is distinct from mantle_inherited_level(owner_id, path, type)`;
    return r!.n;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role)
              values (${member}, 'share-refresh-member@example.invalid', 'x', 'member')`;
    const [personal] = await sql<{ id: string }[]>`
      select id from spaces where login_id = ${member} and kind = 'personal'`;
    if (!personal) throw new Error('the member login has no personal space');
    space = personal.id;

    const node = (
      nodeId: string,
      type: string,
      title: string,
      path: string,
      data: Record<string, string> = {},
      owner: string = brain,
    ) => sql`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${nodeId}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree,
              ${sql.json(data)}, '{}')`;
    for (const root of ['files', 'notes', 'pages', 'tasks']) {
      await node(randomUUID(), 'branch', root, root);
    }
    await node(id.open, 'branch', 'Open', 'files.open');
    await node(id.sub, 'branch', 'Sub', 'files.open.sub');
    await node(id.closed, 'branch', 'Closed', 'files.closed');
    await node(id.quiet, 'branch', 'Quiet', 'files.quiet');
    await node(id.notes, 'branch', 'Notes', 'notes.shared');
    await node(id.docs, 'branch', 'Docs', 'pages.docs');
    await node(id.openFile, 'file', 'open.txt', 'files.open');
    await node(id.subFile, 'file', 'sub.txt', 'files.open.sub');
    await node(id.closedFile, 'file', 'closed.txt', 'files.closed');
    await node(id.quietFile, 'file', 'quiet.txt', 'files.quiet');
    await node(id.pic, 'file', 'pic.png', 'files');
    await node(id.note, 'note', 'With a picture', 'notes.shared', {
      content: `![pic](media:${id.pic})`,
    });
    await node(id.page, 'page', 'A page', 'pages.docs');
    await node(id.task, 'task', 'A task', 'tasks', { status: 'open' });
    await node(randomUUID(), 'branch', 'notes', 'notes', {}, space);
    await node(id.mine, 'branch', 'Mine', 'notes.mine', {}, space);
    await node(id.mineNote, 'note', 'My note', 'notes.mine', { content: 'mine' }, space);
    // With the trigger in place a share reaches everything below the folder.
    await share(id.open, 'team');
    await share(id.quiet, 'client');
    await share(id.notes, 'team');
    await share(id.docs, 'client');
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the migrated trigger compares the text of the path, and refreshes a share', async () => {
    const [t] = await sql<{ def: string }[]>`
      select pg_get_triggerdef(oid) as def from pg_trigger
       where tgname = 'nodes_share_refresh_after' and tgrelid = 'public.nodes'::regclass`;
    expect(t!.def).toMatch(/\(old\.path\)::text IS DISTINCT FROM \(new\.path\)::text/);
    expect(t!.def).toMatch(/EXECUTE FUNCTION (public\.)?mantle_nodes_refresh_trg\(\)/);
    expect(await level(id.openFile)).toBe('team');
    expect(await level(id.sub)).toBe('team');
    expect(await level(id.subFile)).toBe('team');
    expect(await level(id.closedFile)).toBeNull();
    expect(await level(id.quietFile)).toBe('client');
    expect(await level(id.page)).toBe('client');
    // The note is shared with its folder, and the picture it embeds is read
    // through it (0208).
    expect(await row(id.note)).toEqual({ inherited_level: 'team', embedded_level: null });
    expect(await row(id.pic)).toEqual({ inherited_level: null, embedded_level: 'team' });
    // Never: a task, and a member's own rows.
    expect(await level(id.task)).toBeNull();
    expect(await level(id.mineNote)).toBeNull();
  });

  it('on a brain that never lost the trigger, 0212 writes no row', async () => {
    expect(await drifted()).toBe(0);
    const before = await versions();
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(21);
    await migrate();
    expect(await versions()).toEqual(before);
    expect(await hasTrigger()).toBe(true);
  });

  it('without the trigger (a restored brain) a share change no longer reaches the rows below', async () => {
    await sql`drop trigger nodes_share_refresh_after on nodes`;
    expect(await hasTrigger()).toBe(false);
    await share(id.open, null); // an unshare
    await share(id.notes, null); // an unshare of the folder whose note embeds the picture
    await share(id.closed, 'client'); // a new share
    // Stale: the unshared folders' rows are still read at team (fails OPEN),
    // and so is the picture; the newly shared folder's file is not shared.
    expect(await level(id.openFile)).toBe('team');
    expect(await level(id.subFile)).toBe('team');
    expect(await level(id.note)).toBe('team');
    expect((await row(id.pic)).embedded_level).toBe('team');
    expect(await level(id.closedFile)).toBeNull();
    expect(await drifted()).toBe(5);
  });

  it('0212 repairs every stale level, what those rows embed follows, and the trigger is back', async () => {
    const before = await versions();
    await migrate();
    expect(await hasTrigger()).toBe(true);
    expect(await level(id.openFile)).toBeNull();
    expect(await level(id.sub)).toBeNull();
    expect(await level(id.subFile)).toBeNull();
    expect(await level(id.closedFile)).toBe('client');
    expect(await row(id.note)).toEqual({ inherited_level: null, embedded_level: null });
    // The picture is no longer read through the note (nodes_embed_reach_after).
    expect(await row(id.pic)).toEqual({ inherited_level: null, embedded_level: null });
    expect(await drifted()).toBe(0);
    // Only the five stale rows and the picture were written. What was right
    // stays untouched: the other shares, the page, the task, the member's
    // rows, every folder row but the one inside the unshared folder.
    const after = await versions();
    const written = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(written.sort()).toEqual(
      [id.openFile, id.sub, id.subFile, id.closedFile, id.note, id.pic].sort(),
    );
    expect(await level(id.quietFile)).toBe('client');
    expect(await level(id.page)).toBe('client');
  });

  it('a second run writes nothing', async () => {
    const before = await versions();
    await migrate();
    expect(await versions()).toEqual(before);
    expect(await hasTrigger()).toBe(true);
  });

  it('the trigger works again: a share, a folder move and an unshare reach the rows below', async () => {
    await share(id.open, 'team');
    expect(await level(id.openFile)).toBe('team');
    expect(await level(id.subFile)).toBe('team');
    await share(id.open, null);
    expect(await level(id.openFile)).toBeNull();
    expect(await level(id.subFile)).toBeNull();
    // A path change alone (the text comparison in the WHEN clause): the file
    // goes to the new path first, where no folder is yet, then the shared
    // folder arrives there and its refresh reaches the file.
    await sql`update nodes set path = 'files.renamed' where id = ${id.closedFile}`;
    expect(await level(id.closedFile)).toBeNull();
    await sql`update nodes set path = 'files.renamed' where id = ${id.closed}`;
    expect(await level(id.closedFile)).toBe('client');
  });
});

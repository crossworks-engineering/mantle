/**
 * The part-repair task on a scratch brain: old worker-made items in Admin. It
 * changes the ones with the untouched default, and leaves and counts the rest.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/part-repair.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('part-repair', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let repair: typeof import('./part-repair');
  const owner = randomUUID();
  const P = randomUUID();
  const Q = randomUUID();
  let admin = '';
  const ids: Record<string, string> = {};

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const node = async (
    type: string,
    path: string,
    data: Record<string, unknown>,
    tags: string[] = [],
  ) => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${id}, ${owner}, ${type}::node_type, ${id}, ${path}::ltree,
              ${JSON.stringify(data)}::jsonb, ${`{${tags.join(',')}}`}::text[])`);
    return id;
  };
  const state = async (id: string) =>
    (
      await x<{ home: string; read: string[] }>(
        sql`select home_ws::text as home, read_ws::text[] as read from nodes where id = ${id}`,
      )
    )[0]!;
  const old = (id: string) => repair.findOldParts().then((r) => r.find((p) => p.id === id));

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    repair = await import('./part-repair');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`repair-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    admin = (await x<{ id: string }>(sql`select id::text as id from workspaces where is_admin`))[0]!
      .id;
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${P}, ${owner}, 'Proj'), (${Q}, ${owner}, 'Quay')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${P}, ${owner}, true), (${Q}, ${owner}, true)`);
    await node('branch', 'files.auto_filed_old', { system: true });
    const file = await node('file', 'files', {});
    await m.withHeads([file], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${file}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
        values (${file}, ${P}, true)`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
        values (${file}, ${Q}, true)`);
    });
    ids.file = file;
    const source = { sourceFileId: file };
    ids.ready = await node('table', 'tables', source, ['auto-import']);
    ids.image = await node('file', 'files.auto_filed_old', { ...source, sourceOrdinal: 1 }, [
      'extracted-image',
    ]);
    // Changed by hand: a grant, a "Removed here", a move.
    ids.handGrant = await node('table', 'tables', source, ['auto-import']);
    ids.removed = await node('table', 'tables', source, ['auto-import']);
    ids.moved = await node('table', 'tables', source, ['auto-import']);
    await m.withHeads([ids.handGrant, ids.removed, ids.moved], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, granted_by)
        values (${ids.handGrant}, ${Q}, true, ${owner})`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, excluded, granted_by)
        values (${ids.removed}, ${P}, true, ${owner})`);
      await tx.execute(sql`update item_grants set workspace_id = ${Q}, granted_by = ${owner}
                            where node_id = ${ids.moved} and is_home`);
    });
    ids.second = await node('table', 'tables', source, ['auto-import']);
    // A hand Write switch on the Admin home row.
    ids.handWrite = await node('table', 'tables', source, ['auto-import']);
    await m.withHeads([ids.handWrite], 'update', (tx) =>
      tx.execute(
        sql`update item_grants set write = true where node_id = ${ids.handWrite} and is_home`,
      ),
    );
    // Placed by hand in a folder Q reads.
    const shared = await node('branch', 'tables.shared', {});
    await m.withSubtreeHeads(shared, [], (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${shared}, ${Q})`),
    );
    ids.placed = await node('table', 'tables.shared', source, ['auto-import']);
    // A file that gives nothing but the Admin default: nothing to do, ever.
    const adminFile = await node('file', 'files', {});
    ids.adminOnly = await node('table', 'tables', { sourceFileId: adminFile }, ['auto-import']);
    // A file whose home is archived.
    const deadWs = randomUUID();
    await su(sql`insert into workspaces (id, owner_id, name) values (${deadWs}, ${owner}, 'Gone')`);
    const deadFile = await node('file', 'files', {});
    await m.withHeads([deadFile], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${deadFile}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
        values (${deadFile}, ${deadWs}, true)`);
    });
    await su(sql`update workspaces set archived_at = now() where id = ${deadWs}`);
    ids.noHome = await node('table', 'tables', { sourceFileId: deadFile }, ['auto-import']);
    // Its file is deleted.
    ids.orphan = await node('table', 'tables', { sourceFileId: randomUUID() }, ['auto-import']);
    // A user's copy, and a video's audio: not the worker's.
    ids.copy = await node('table', 'tables', source, []);
    ids.audio = await node('file', 'files', source, []);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const readyIds = async () =>
    (await repair.findOldParts()).filter((r) => r.ready).map((r) => r.id);

  it('finds the worker-made items, sorts them, and a dry run writes nothing', async () => {
    const before = await state(ids.ready!);
    expect((await readyIds()).sort()).toEqual([ids.ready!, ids.image!, ids.second!].sort());
    const rows = await repair.findOldParts();
    expect(rows.filter((r) => r.gone).map((r) => r.id)).toEqual([ids.orphan]);
    for (const id of [
      ids.handGrant,
      ids.removed,
      ids.moved,
      ids.handWrite,
      ids.placed,
      ids.adminOnly,
      ids.noHome,
    ]) {
      expect((await old(id!))?.ready, id).toBe(false);
    }
    expect(await old(ids.copy!)).toBeUndefined();
    expect(await old(ids.audio!)).toBeUndefined();
    expect(before.home).toBe(admin);
    const log: string[] = [];
    expect(await repair.runPartRepair({ apply: false, limit: 100 }, (l) => log.push(l))).toBe(true);
    expect(log.join('\n')).toContain('DRY RUN');
    expect(await state(ids.ready!)).toEqual(before);
    expect(log.join('\n')).not.toContain(before.read[0]!);
  });

  it('--limit changes at most that many, and each run reaches the next', async () => {
    const ready = await readyIds();
    const log: string[] = [];
    expect(await repair.runPartRepair({ apply: true, limit: 1 }, (l) => log.push(l))).toBe(true);
    expect(log.filter((l) => l.includes('  changed'))).toHaveLength(1);
    expect(await readyIds()).toHaveLength(ready.length - 1);
    await repair.runPartRepair({ apply: true, limit: 1 }, () => undefined);
    expect(await readyIds()).toHaveLength(ready.length - 2);
  });

  it("gives a ready item the file's home and grants, and leaves the rest", async () => {
    const both = [P, Q].sort();
    await repair.runPartRepair({ apply: true, limit: 100 }, () => undefined);
    expect(await state(ids.ready!)).toEqual({ home: P, read: both });
    // An image out of its Admin folder's row too.
    expect(await state(ids.image!)).toEqual({ home: P, read: both });
    const [w] = await x<{ write: boolean }>(sql`select write from item_grants
      where node_id = ${ids.ready} and workspace_id = ${Q}`);
    expect(w!.write).toBe(true);
    expect((await state(ids.handGrant!)).home).toBe(admin);
    expect((await state(ids.removed!)).home).toBe(admin);
    expect((await state(ids.moved!)).home).toBe(Q);
    expect((await state(ids.orphan!)).home).toBe(admin);
    expect((await state(ids.copy!)).home).toBe(admin);
    expect((await state(ids.handWrite!)).home).toBe(admin);
    expect((await state(ids.placed!)).home).toBe(admin);
    // A hand placing in a shared folder keeps its reader.
    expect((await state(ids.placed!)).read).toContain(Q);
    expect((await state(ids.adminOnly!)).home).toBe(admin);
    // A second run changes nothing: no item is ready.
    expect(await readyIds()).toEqual([]);
  });

  it('a hand edit since the read is left, and one failure does not stop the run', async () => {
    const edited = await node('table', 'tables', { sourceFileId: ids.file }, ['auto-import']);
    const [row] = (await repair.findOldParts()).filter((r) => r.id === edited);
    expect(row?.ready).toBe(true);
    await m.withHeads([edited], 'update', (tx) =>
      tx.execute(sql`update item_grants set granted_by = ${owner}
                      where node_id = ${edited} and is_home`),
    );
    expect(await repair.repairOldPart(row!)).toBe(false);
    expect((await state(edited)).home).toBe(admin);
    // One failure: counted, the run goes on, and it answers false.
    const a = await node('table', 'tables', { sourceFileId: ids.file }, ['auto-import']);
    const b = await node('table', 'tables', { sourceFileId: ids.file }, ['auto-import']);
    const log: string[] = [];
    const ok = await repair.runPartRepair(
      { apply: true, limit: 100 },
      (l) => log.push(l),
      async (p) => {
        if (p.id === a) throw new Error('refused');
        return repair.repairOldPart(p);
      },
    );
    expect(ok).toBe(false);
    expect((await state(a)).home).toBe(admin);
    expect((await state(b)).home).toBe(P);
    expect(log.join('\n')).toContain('failed 1');
  });
});

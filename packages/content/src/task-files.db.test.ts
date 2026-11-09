/**
 * Files on tasks (plan page 74b70ac6) on a real, migrated Postgres and a
 * temporary files root. The one rule is the task's right:
 *
 *  - a member whose workspace holds the task with Write on adds, lists,
 *    opens and removes its files;
 *  - with Write off it lists and opens them, and may not add or remove;
 *  - a task it does not read is a 404 for every act;
 *  - a file that is not in the task's folder is never opened through it;
 *  - the caps: the type list, an empty file, 10 MB, 5 files;
 *  - deleting the task takes its files and its folder.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/task-files.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('files on tasks', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tf: typeof import('./task-files');
  let tasks: typeof import('./tasks');
  let files: typeof import('@mantle/files');
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let su: typeof admin | undefined;
  let root = '';
  let prevRoot: string | undefined;
  // The brain's own anchor (mantle_brain_id()): the database homes an item
  // of no other owner nowhere, so a task file's home is only real on it.
  let anchor = '';
  const member = randomUUID();
  const tag = member.slice(0, 8);
  const ws = { admin: '', team: randomUUID() };
  const task = { write: randomUUID(), read: randomUUID(), none: randomUUID(), team: randomUUID() };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  // A turn scope with writes: every query in its own short transaction, as
  // a request runs (the system step refuses an open scope transaction).
  const asMember = <T>(fn: () => Promise<T>) =>
    m.withTurnScope({ kind: 'user', loginId: member, ws: [ws.team], modWs: [] }, fn, {
      writes: true,
    });
  const asAdmin = <T>(fn: () => Promise<T>) =>
    m.withTurnScope({ kind: 'user', loginId: anchor, ws: [ws.admin], modWs: [ws.admin] }, fn, {
      writes: true,
    });
  const grant = (node: string, wsId: string, write: boolean, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, ${write}, ${home})`),
    );
  const add = (taskId: string, filename: string, bytes: Buffer = png) =>
    tf.addTaskFile({ ownerId: anchor, taskId, filename, bytes });
  /** What the act answered: 'ok', the edit check's refusal ('no_read' is
   *  the 404, 'no_edit' the 403, by the one mapper), or the error's name. */
  const statusOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      const e = err as { code?: string; detail?: string; name?: string };
      return e.code === '42501' ? e.detail : e.name;
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-task-files-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    su = (await import('@mantle/db/test-support')).superuserClient(URL!);
    tf = await import('./task-files');
    tasks = await import('./tasks');
    files = await import('@mantle/files');
    const support = await import('@mantle/db/test-support');
    anchor = await support.ensureTestAnchor(admin);
    ws.admin = await support.ensureAdminUsers(admin, []);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${`tf-${tag}-m@example.invalid`}, 'x', 'member')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict do nothing`;
    await su!`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.team}, ${anchor}, ${`${tag} Team`}, false)`;
    await su!`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.team}, ${member}, false)`;
    await files.ensureFilesRootBranch(anchor);
    for (const [key, id] of Object.entries(task)) {
      await admin`insert into nodes (id, owner_id, type, title, path, data)
        values (${id}, ${anchor}, 'task', ${`${tag} ${key}`}, 'tasks', '{"status":"open"}'::jsonb)`;
      // The grants are the test's own: the default home goes first.
      await m.withHeads([id], 'update', (tx) =>
        tx.execute(m.sql`delete from item_grants where node_id = ${id}`),
      );
      if (key !== 'team') await grant(id, ws.admin, false, true);
    }
    await grant(task.team, ws.team, true, true);
    await grant(task.write, ws.team, true);
    await grant(task.read, ws.team, false);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    // Only this test's rows: the anchor, its Admin workspace and its
    // Auto-filed folders are shared with other tests.
    const ids = Object.values(task);
    const folders = ids.map((id) => tf.taskFilesPath(id));
    await admin`delete from item_grants where node_id in (select id from nodes
      where owner_id = ${anchor} and (id in ${admin(ids)} or path::text in ${admin(folders)}))`;
    await admin`delete from nodes where owner_id = ${anchor}
      and (id in ${admin(ids)} or path::text in ${admin(folders)})`;
    if (su) {
      await su`delete from workspaces where id = ${ws.team}`;
      await su.end();
    }
    await admin`delete from auth.users where id = ${member}`;
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
    await m.closeDb();
  });

  it('Write on: a member adds, lists, opens and removes; a taken name gets -2', async () => {
    const a = await asMember(() => add(task.write, 'Image.PNG'));
    const b = await asMember(() => add(task.write, 'image.png'));
    expect(a?.filename).toBe('image.png');
    expect(b?.filename).toBe('image-2.png');
    const listed = await asMember(() => tf.listTaskFiles(anchor, task.write));
    expect(listed.map((f) => f.filename)).toEqual(['image.png', 'image-2.png']);
    expect(listed[0]!.mimeType).toBe('image/png');
    const opened = await asMember(() => tf.readTaskFile(anchor, task.write, a!.id));
    expect(opened?.bytes.equals(png)).toBe(true);
    // Stored by name only, in the task's own Auto-filed folder.
    const [row] = (await admin`select path::text as path, data->>'indexing' as indexing
      from nodes where id = ${a!.id}`) as unknown as { path: string; indexing: string }[];
    expect(row).toEqual({ path: tf.taskFilesPath(task.write), indexing: 'metadata' });
    expect(await asMember(() => tf.removeTaskFile(anchor, task.write, b!.id))).toBe(true);
    expect((await asMember(() => tf.listTaskFiles(anchor, task.write))).length).toBe(1);
  });

  it('Write off: a member lists and opens, and may not add or remove', async () => {
    const f = await asAdmin(() => add(task.read, 'log.txt', Buffer.from('boom')));
    expect(f).not.toBeNull();
    const listed = await asMember(() => tf.listTaskFiles(anchor, task.read));
    expect(listed.map((x) => x.filename)).toEqual(['log.txt']);
    const opened = await asMember(() => tf.readTaskFile(anchor, task.read, f!.id));
    expect(opened?.bytes.toString()).toBe('boom');
    expect(await statusOf(asMember(() => add(task.read, 'more.txt', Buffer.from('x'))))).toBe(
      'no_edit',
    );
    expect(await statusOf(asMember(() => tf.removeTaskFile(anchor, task.read, f!.id)))).toBe(
      'no_edit',
    );
    expect((await asAdmin(() => tf.listTaskFiles(anchor, task.read))).length).toBe(1);
  });

  it('a task the member does not read: a 404 for every act', async () => {
    const f = await asAdmin(() => add(task.none, 'secret.txt', Buffer.from('s')));
    expect(await statusOf(asMember(() => tf.listTaskFiles(anchor, task.none)))).toBe('no_read');
    expect(await statusOf(asMember(() => tf.readTaskFile(anchor, task.none, f!.id)))).toBe(
      'no_read',
    );
    expect(await statusOf(asMember(() => add(task.none, 'x.txt', Buffer.from('x'))))).toBe(
      'no_read',
    );
  });

  it("a file outside the task's folder is never opened through the task", async () => {
    // The file of another task, asked through a task the member may edit.
    const other = await asAdmin(() => tf.listTaskFiles(anchor, task.none));
    expect(await asMember(() => tf.readTaskFile(anchor, task.write, other[0]!.id))).toBeNull();
    expect(await asMember(() => tf.removeTaskFile(anchor, task.write, other[0]!.id))).toBe(false);
  });

  it('the caps: the type list, an empty file, 10 MB, 5 files', async () => {
    const s = (p: Promise<unknown>) => statusOf(asAdmin(() => p));
    expect(await s(add(task.write, 'x.svg', Buffer.from('<svg/>')))).toBe('InputError');
    expect(await s(add(task.write, 'x.html', Buffer.from('<p>')))).toBe('InputError');
    expect(await s(add(task.write, 'empty.txt', Buffer.alloc(0)))).toBe('InputError');
    const big = Buffer.alloc(tf.TASK_FILE_MAX_BYTES + 1);
    expect(await s(add(task.write, 'big.log', big))).toBe('InputError');
    const have = (await asAdmin(() => tf.listTaskFiles(anchor, task.write))).length;
    for (let i = have; i < tf.TASK_FILES_MAX; i++) {
      await asAdmin(() => add(task.write, `n${i}.txt`, Buffer.from('n')));
    }
    expect(await s(add(task.write, 'sixth.txt', Buffer.from('6')))).toBe('InputError');
    expect((await asAdmin(() => tf.listTaskFiles(anchor, task.write))).length).toBe(
      tf.TASK_FILES_MAX,
    );
  });

  it("a file takes its task's home, never Admin by the folder's default", async () => {
    const f = await asMember(() => add(task.team, 'shot.png'));
    const [row] = (await admin`select home_ws::text as home from nodes
      where id = ${f!.id}`) as unknown as { home: string }[];
    expect(row!.home).toBe(ws.team);
  });

  it('deleting a task takes its files and its folder', async () => {
    const ids = (await asAdmin(() => tf.listTaskFiles(anchor, task.write))).map((f) => f.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(await asAdmin(() => tasks.deleteTask(anchor, task.write))).toBe(true);
    const left = (await admin`select count(*)::int as n from nodes
      where id in ${admin(ids)} or (owner_id = ${anchor} and type = 'branch'
        and path = ${tf.taskFilesPath(task.write)}::ltree)`) as unknown as { n: number }[];
    expect(left[0]!.n).toBe(0);
  });
});

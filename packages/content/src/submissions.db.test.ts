/**
 * Submit a bug, feature or request (plan page 5559936a) on a real, migrated
 * Postgres and a temporary files root:
 *
 *  - a member who may edit a task sends it to Admin: a copy lands in the
 *    Admin workspace with copies of the files, and the task says sent;
 *  - a second send is a 409; a task the member does not edit is refused;
 *  - the member does not read the copy; an Admin replies on it once, and
 *    both tasks become done with the reply on the person's task;
 *  - a task edit never writes the submission block.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/submissions.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('submissions', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sub: typeof import('./submissions');
  let tf: typeof import('./task-files');
  let tasks: typeof import('./tasks');
  let files: typeof import('@mantle/files');
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let su: typeof admin | undefined;
  let root = '';
  let prevRoot: string | undefined;
  let anchor = '';
  const member = randomUUID();
  const tag = member.slice(0, 8);
  const ws = { admin: '', team: randomUUID() };
  const task = { mine: randomUUID(), read: randomUUID() };
  const made: string[] = [];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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
    root = await mkdtemp(path.join(tmpdir(), 'mantle-submissions-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    su = (await import('@mantle/db/test-support')).superuserClient(URL!);
    sub = await import('./submissions');
    tf = await import('./task-files');
    tasks = await import('./tasks');
    files = await import('@mantle/files');
    const support = await import('@mantle/db/test-support');
    anchor = await support.ensureTestAnchor(su!);
    ws.admin = await support.ensureAdminUsers(su!, []);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role, display_name)
      values (${member}, ${`sb-${tag}-m@example.invalid`}, 'x', 'member', 'Sam')`;
    await su!`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict do nothing`;
    await su!`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.team}, ${anchor}, ${`${tag} Team`}, false)`;
    await su!`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.team}, ${member}, false)`;
    await files.ensureFilesRootBranch(anchor);
    for (const [key, id] of Object.entries(task)) {
      await su!`insert into nodes (id, owner_id, type, title, path, data)
        values (${id}, ${anchor}, 'task', ${`${tag} ${key}`}, 'tasks',
          '{"status":"open","body":"It breaks"}'::jsonb)`;
      await m.withHeads([id], 'update', (tx) =>
        tx.execute(m.sql`delete from item_grants where node_id = ${id}`),
      );
      await grant(id, ws.team, key === 'mine', true);
    }
  }, 120_000);

  afterAll(async () => {
    if (!su) return;
    const ids = [...Object.values(task), ...made];
    const folders = ids.map((id) => tf.taskFilesPath(id));
    await su!`delete from item_grants where node_id in (select id from nodes
      where owner_id = ${anchor} and (id in ${su!(ids)} or path::text in ${su!(folders)}))`;
    await su!`delete from nodes where owner_id = ${anchor}
      and (id in ${su!(ids)} or path::text in ${su!(folders)})`;
    await su`delete from workspaces where id = ${ws.team}`;
    await su`delete from auth.users where id = ${member}`;
    await su.end();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
    await m.closeDb();
  });

  it('send to Admin: a copy in Admin with copies of the files; the task says sent', async () => {
    await asMember(() =>
      tf.addTaskFile({ ownerId: anchor, taskId: task.mine, filename: 'shot.png', bytes: png }),
    );
    const sent = await asMember(() =>
      sub.submitTask(anchor, task.mine, { kind: 'bug', to: 'admin', byLogin: member }),
    );
    const s = sent?.submission;
    expect(s?.side).toBe('sent');
    if (s?.side !== 'sent') return;
    expect(s.to).toBe('admin');
    expect(sent!.tags).toContain('bug');
    expect(s.copyId).toBeTruthy();
    made.push(s.copyId!);
    const [row] = (await su!`select home_ws::text as home, title, data->'submission' as sub
      from nodes where id = ${s.copyId!}`) as unknown as {
      home: string;
      title: string;
      sub: { side: string; from: { taskId: string; by: { name: string } } };
    }[];
    expect(row!.home).toBe(ws.admin);
    expect(row!.sub.side).toBe('received');
    expect(row!.sub.from.taskId).toBe(task.mine);
    expect(row!.sub.from.by.name).toBe('Sam');
    const copied = await asAdmin(() => tf.listTaskFiles(anchor, s.copyId!));
    expect(copied.map((f) => f.filename)).toEqual(['shot.png']);
  });

  it('a second send is a 409; a task the member may not edit is refused', async () => {
    expect(
      await statusOf(
        asMember(() =>
          sub.submitTask(anchor, task.mine, { kind: 'bug', to: 'admin', byLogin: member }),
        ),
      ),
    ).toBe('ConflictError');
    expect(
      await statusOf(
        asMember(() =>
          sub.submitTask(anchor, task.read, { kind: 'request', to: 'admin', byLogin: member }),
        ),
      ),
    ).toBe('no_edit');
  });

  it('the member does not read the copy; an Admin replies once; both tasks are done', async () => {
    const copyId = made[0]!;
    expect(
      await statusOf(
        asMember(() =>
          sub.replyToSubmission(anchor, copyId, { note: 'x', version: 'v1', byLogin: member }),
        ),
      ),
    ).toBe('no_read');
    const replied = await asAdmin(() =>
      sub.replyToSubmission(anchor, copyId, {
        note: 'Fixed the export.',
        version: 'v0.500.42',
        byLogin: anchor,
      }),
    );
    expect(replied?.status).toBe('done');
    const mine = await asMember(() => tasks.getTask(anchor, task.mine));
    expect(mine?.status).toBe('done');
    const s = mine?.submission;
    expect(s?.side === 'sent' && s.reply?.note).toBe('Fixed the export.');
    expect(s?.side === 'sent' && s.reply?.version).toBe('v0.500.42');
    expect(
      await statusOf(
        asAdmin(() =>
          sub.replyToSubmission(anchor, copyId, { note: 'again', version: '', byLogin: anchor }),
        ),
      ),
    ).toBe('ConflictError');
    // Only a copy takes a reply.
    expect(
      await statusOf(
        asMember(() =>
          sub.replyToSubmission(anchor, task.mine, { note: 'x', version: '', byLogin: member }),
        ),
      ),
    ).toBe('InputError');
  });

  it('a task edit never writes the submission block', async () => {
    await asMember(() => tasks.updateTask(anchor, task.mine, { status: 'open', title: 'New' }));
    const mine = await asMember(() => tasks.getTask(anchor, task.mine));
    expect(mine?.title).toBe('New');
    expect(mine?.submission?.side).toBe('sent');
    expect(mine?.submission?.reply?.note).toBe('Fixed the export.');
  });
});

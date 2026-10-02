/**
 * Reopen restores the status a task had before it was marked done, on a real,
 * migrated Postgres. The brain remembers it (`data.status_before_done`), not
 * the client, so every way in behaves the same:
 *
 *   - PATCH /api/tasks/:id (the web tree menu, the board, the phone);
 *   - the task_update tool (agents);
 *   - the item tree row, which names where a reopen goes (`meta.reopensTo`).
 *
 * Each request below reads state the previous request left in the database,
 * so "reload between done and reopen" is the normal case here: nothing is
 * kept in memory between the two calls.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run 'server/web/app/api/tasks/[id]/reopen.db.test.ts'
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ owner: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.owner),
}));

type Row = Record<string, unknown>;

describe.skipIf(!URL)('reopen restores the status before done', () => {
  let m: typeof import('@mantle/db');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let taskRoute: typeof import('./route');
  let tasksRoute: typeof import('../route');
  let tools: typeof import('@mantle/tools');
  let tree: typeof import('@mantle/content/tree');
  const owner = randomUUID();
  const tag = `reopen-${owner.slice(0, 8)}`;

  const call = async (id: string, method: 'GET' | 'PATCH', body?: unknown) => {
    const req = new Request(`http://brain.test/api/tasks/${id}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const ctx = { params: Promise.resolve({ id }) };
    const res = method === 'GET' ? await taskRoute.GET(req, ctx) : await taskRoute.PATCH(req, ctx);
    expect(res.status).toBe(200);
    return ((await res.json()) as { task: TaskRow }).task;
  };
  const patch = (id: string, body: unknown) => call(id, 'PATCH', body);
  const get = (id: string) => call(id, 'GET');

  const create = async (title: string, status?: string) => {
    const res = await tasksRoute.POST(
      new Request('http://brain.test/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, ...(status ? { status } : {}) }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { task: TaskRow }).task;
  };

  const tool = async (input: Record<string, unknown>) => {
    const update = tools.TASK_TOOLS.find((t) => t.slug === 'task_update')!;
    const res = await update.handler(input, { ownerId: owner });
    if (!res.ok) throw new Error(res.error);
    return res.output as TaskRow;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    taskRoute = await import('./route');
    tasksRoute = await import('../route');
    tools = await import('@mantle/tools');
    tree = await import('@mantle/content/tree');
    h.owner = { id: owner };
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from spaces where id = ${owner} or login_id = ${owner}`;
    await admin`delete from auth.users where id = ${owner}`;
    await m.closeDb();
  });

  it('a Blocked task marked done reopens as Blocked, through a fresh read', async () => {
    const t = await create('Blocked one');
    await patch(t.id, { status: 'blocked' });
    const done = await patch(t.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.statusBeforeDone).toBe('blocked');
    // A later, separate read still knows it (a reload, another client).
    expect((await get(t.id)).statusBeforeDone).toBe('blocked');
    const back = await patch(t.id, { reopen: true });
    expect(back.status).toBe('blocked');
    expect(back.statusBeforeDone).toBeNull();
    const [row] = await admin`select data from nodes where id = ${t.id}`;
    expect((row!.data as Row).status_before_done).toBeUndefined();
  });

  it('an In progress task reopens as In progress', async () => {
    const t = await create('Working one');
    await patch(t.id, { status: 'in_progress' });
    await patch(t.id, { status: 'done' });
    expect((await patch(t.id, { reopen: true })).status).toBe('in_progress');
  });

  it('falls back to To do when the brain does not know the old status', async () => {
    const createdDone = await create('Born done', 'done');
    expect(createdDone.statusBeforeDone).toBeNull();
    expect((await patch(createdDone.id, { reopen: true })).status).toBe('open');

    // A task marked done before the brain recorded it: no key at all.
    const legacy = await create('Legacy done');
    await admin`update nodes set data = data || '{"status":"done"}'::jsonb where id = ${legacy.id}`;
    expect((await patch(legacy.id, { reopen: true })).status).toBe('open');

    // A To do task marked done comes back as To do.
    const plain = await create('Plain one');
    await patch(plain.id, { status: 'done' });
    expect((await patch(plain.id, { reopen: true })).status).toBe('open');
  });

  it('an explicit status on reopen wins', async () => {
    const t = await create('Explicit one');
    await patch(t.id, { status: 'blocked' });
    await patch(t.id, { status: 'done' });
    const res = await patch(t.id, { reopen: true, status: 'in_progress' });
    expect(res.status).toBe('in_progress');
    // A plain status move out of done is explicit too (a board drag).
    const u = await create('Dragged one');
    await patch(u.id, { status: 'blocked' });
    await patch(u.id, { status: 'done', rank: 'm' });
    expect((await patch(u.id, { status: 'open', rank: 'n' })).status).toBe('open');
  });

  it('reopen leaves a task that is not done alone; done twice keeps the first', async () => {
    const t = await create('Not done');
    await patch(t.id, { status: 'blocked' });
    expect((await patch(t.id, { reopen: true })).status).toBe('blocked');
    await patch(t.id, { status: 'done' });
    await patch(t.id, { status: 'done' });
    expect((await patch(t.id, { reopen: true })).status).toBe('blocked');
  });

  it('works the same through the task_update tool agents use', async () => {
    const t = await create('Agent one');
    await tool({ id: t.id, status: 'blocked' });
    const done = await tool({ id: t.id, status: 'done' });
    expect(done.statusBeforeDone).toBe('blocked');
    // Done by the web, reopened by an agent: the brain carries it between.
    expect((await tool({ id: t.id, reopen: true })).status).toBe('blocked');
    await patch(t.id, { status: 'in_progress' });
    await tool({ id: t.id, status: 'done' });
    expect((await patch(t.id, { reopen: true })).status).toBe('in_progress');
    await tool({ id: t.id, status: 'done' });
    expect((await tool({ id: t.id, reopen: true, status: 'open' })).status).toBe('open');
  });

  it('the tree row names where a reopen goes', async () => {
    const t = await create('Tree one');
    await patch(t.id, { status: 'blocked' });
    await patch(t.id, { status: 'done' });
    const plain = await create('Tree plain', 'done');
    const page = await tree.loadTreeFolder(owner, 'tasks', {});
    const meta = (id: string) => page!.items.find((i) => i.id === id)?.meta;
    expect(meta(t.id)).toMatchObject({ done: true, reopensTo: 'blocked' });
    expect(meta(plain.id)?.done).toBe(true);
    expect(meta(plain.id)?.reopensTo).toBeUndefined();
  });
});

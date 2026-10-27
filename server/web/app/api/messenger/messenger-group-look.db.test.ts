/**
 * A group's look on a real, migrated Postgres (0341, plan page d8954876
 * section 23): an icon (one emoji) and a colour (an app tint key) on a
 * group, through the routes the chat window calls.
 *
 *  - POST /api/messenger/conversations takes both for a group; a direct
 *    chat ignores them (stored null, answered null);
 *  - PATCH /api/messenger/c/:id: a group admin sets and clears them, and
 *    each change raises the room's `participants` event (as a title
 *    change does); a member who is not an admin is refused (403); a bad
 *    tint and an icon that is no emoji are a 400; a direct chat has no
 *    admin (403);
 *  - the list row and the conversation carry them, read in the caller's
 *    scope (the workspace role's column grant, ACCESS_MATRIX).
 *
 * The caller (anyLoginCaller) is a stand-in; every route runs in the
 * caller's own scope (withViewer), as the gate runs it, and a thrown error
 * is answered as the app answers it (answerAppError).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run messenger-group-look.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ login: '', owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  anyLoginCaller: vi.fn(() => ({ loginId: h.login, brainId: h.owner })),
}));

type Route = (req: Request, ctx?: { params: Promise<object> }) => Promise<Response>;

describe.skipIf(!URL)("a group's icon and colour (0341)", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('@mantle/content/messenger');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  const r: Record<string, Route> = {};
  const changed: string[] = [];
  let unlisten: (() => Promise<void>) | null = null;

  const tag = `mgl${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const W = randomUUID();

  /** Call a route as `loginId`, in its own scope. */
  const as = async (
    loginId: string,
    route: string,
    path: string,
    init?: { method: string; body?: unknown },
    params?: object,
  ) => {
    h.login = loginId;
    const call = m.withViewer({ login: loginId }, () =>
      r[route]!(
        new Request(`http://brain.test${path}`, {
          method: init?.method ?? 'GET',
          ...(init?.body !== undefined
            ? {
                body: JSON.stringify(init.body),
                headers: { 'content-type': 'application/json' },
              }
            : {}),
        }),
        params ? { params: Promise.resolve(params) } : undefined,
      ),
    );
    // A thrown domain error is answered as the app's onError answers it
    // (answerAppError: a refusal 403, an InputError 400).
    try {
      return await call;
    } catch (err) {
      const { answerAppError } = await import('@/server/app-error');
      return answerAppError(
        err as Error,
        {
          req: { url: `http://brain.test${path}`, method: init?.method ?? 'GET' },
        } as never,
      );
    }
  };
  const create = (loginId: string, body: unknown) =>
    as(loginId, 'create', '/api/messenger/conversations', { method: 'POST', body });
  const patch = (loginId: string, id: string, body: unknown) =>
    as(loginId, 'patch', `/api/messenger/c/${id}`, { method: 'PATCH', body }, { id });
  const conv = async (res: Response) =>
    ((await res.json()) as { conversation: Record<string, unknown> }).conversation;
  /** Wait for a NOTIFY of `kind` on conversation `c` (the trigger's). */
  const event = async (c: string, kind: string) => {
    for (let i = 0; i < 50; i++) {
      if (changed.some((p) => JSON.parse(p).c === c && JSON.parse(p).kind === kind)) return true;
      await new Promise((res) => setTimeout(res, 20));
    }
    return false;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('@mantle/content/messenger');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    h.owner = owner;
    const pool = (
      m.systemDb as unknown as {
        $client: {
          listen: (
            c: string,
            cb: (p: string) => void,
          ) => Promise<{ unlisten: () => Promise<void> }>;
        };
      }
    ).$client;
    unlisten = (await pool.listen('messenger_changed', (p) => changed.push(p))).unlisten;

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben')`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B})`);
    await su(
      sqlTag`insert into workspace_users (workspace_id, login_id) values (${W}, ${A}), (${W}, ${B})`,
    );

    const list = await import('./conversations/route');
    r.create = list.POST as Route;
    r.list = list.GET as Route;
    const one = await import('./c/[id]/route');
    r.patch = one.PATCH as Route;
    r.get = one.GET as Route;
  }, 180_000);

  beforeEach(() => ms?.resetMessengerBudgetsForTests());

  afterAll(async () => {
    await unlisten?.().catch(() => {});
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('a group is created with an icon and a colour; the list and the room carry them', async () => {
    const res = await create(A, {
      kind: 'group',
      participants: [B],
      title: 'Ops',
      icon: '🚀',
      color: 'teal',
    });
    expect(res.status).toBe(201);
    const c = await conv(res);
    expect(c).toMatchObject({ kind: 'group', title: 'Ops', icon: '🚀', color: 'teal' });
    // Ben reads it in his own scope: the room and the list row.
    const room = await conv(
      await as(B, 'get', `/api/messenger/c/${c.id}`, undefined, { id: c.id }),
    );
    expect(room).toMatchObject({ icon: '🚀', color: 'teal' });
    const list = (await (await as(B, 'list', '/api/messenger/conversations')).json()) as {
      rows: Record<string, unknown>[];
    };
    expect(list.rows.find((x) => x.id === c.id)).toMatchObject({ icon: '🚀', color: 'teal' });
  });

  it('a group admin sets and clears them; each change raises the participants event', async () => {
    const c = await conv(await create(A, { kind: 'group', participants: [B], title: 'Look' }));
    expect(c).toMatchObject({ icon: null, color: null });
    const id = c.id as string;

    changed.length = 0;
    const set = await patch(A, id, { icon: '🎯', color: 'violet' });
    expect(set.status).toBe(200);
    expect(await conv(set)).toMatchObject({ icon: '🎯', color: 'violet' });
    expect(await event(id, 'participants')).toBe(true);

    // The colour alone; the icon stays.
    changed.length = 0;
    expect(await conv(await patch(A, id, { color: 'amber' }))).toMatchObject({
      icon: '🎯',
      color: 'amber',
    });
    expect(await event(id, 'participants')).toBe(true);

    // null and '' clear.
    changed.length = 0;
    expect(await conv(await patch(A, id, { icon: null, color: '' }))).toMatchObject({
      icon: null,
      color: null,
    });
    expect(await event(id, 'participants')).toBe(true);
    // The same values again change nothing in the row: no event.
    changed.length = 0;
    await patch(A, id, { icon: null });
    expect(await event(id, 'participants')).toBe(false);
  });

  it('a member who is not an admin is refused; a bad tint and a non-emoji icon are a 400', async () => {
    const c = await conv(await create(A, { kind: 'group', participants: [B], icon: '🌱' }));
    const id = c.id as string;
    const refused = await patch(B, id, { color: 'teal' });
    expect(refused.status).toBe(403);
    for (const body of [
      { color: 'mauve' },
      { color: 'Teal' },
      { icon: 'chart-bar' },
      { icon: 'lucide:rocket' },
      { icon: '🎉'.repeat(9) },
    ]) {
      const res = await patch(A, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // A bad create is refused too, and makes no group.
    expect((await create(A, { kind: 'group', participants: [B], color: 'mauve' })).status).toBe(
      400,
    );
    // Nothing changed.
    const room = await conv(await as(A, 'get', `/api/messenger/c/${id}`, undefined, { id }));
    expect(room).toMatchObject({ icon: '🌱', color: null });
  });

  it('a direct chat ignores them on create, and has no admin to change them', async () => {
    const res = await create(A, { kind: 'direct', participants: [B], icon: '🚀', color: 'teal' });
    expect([200, 201]).toContain(res.status);
    const c = await conv(res);
    expect(c).toMatchObject({ kind: 'direct', icon: null, color: null });
    const [row] = (await su(
      sqlTag`select icon, color from messenger_conversations where id = ${c.id as string}`,
    )) as { icon: string | null; color: string | null }[];
    expect(row).toEqual({ icon: null, color: null });
    expect((await patch(A, c.id as string, { icon: '🚀' })).status).toBe(403);
    // The database holds the rule too.
    await expect(
      su(sqlTag`update messenger_conversations set color = 'teal' where id = ${c.id as string}`),
    ).rejects.toThrow();
  });
});

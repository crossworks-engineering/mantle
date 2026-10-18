/**
 * The Admin login is role AND membership (workspaces arch plan v3.2),
 * on a real migrated Postgres, through the real app (createApp) and the real
 * login row (loadLoginRow reads mantle_login_is_admin with the row).
 *
 * The two named narrowing cells, each next to its as-before cell:
 *  - a login with role admin outside the Admin workspace (role drift) loses
 *    its `?at=` asset token, its render cookie and the frame re-check
 *    (adminLoginActive); an Admin user keeps all three. It keeps its
 *    session (owner decision: the session stays on the role until
 *    S8b) and works in its own scope as on main, but is not Admin: an Admin
 *    area route refuses it;
 *  - a role=member login inside the Admin workspace is not an Admin login:
 *    it stays a member (the member gate lets it in, the owner gate refuses
 *    it as it refuses any member).
 *
 * Member-negative (plan rule 5): an outsider and the drift admin are
 * refused the asset token with the answer a random uuid's token gets, a
 * role=member login inside Admin answers as any member, and every non-Admin
 * render cookie as a random uuid's, byte for byte.
 *
 * The area asks (requireArea): in a scope for the caller's own login the
 * scope's rule; unscoped, the area rule about the login; in a scope for
 * another login it throws. areasFor is mantle_login_areas.
 *
 * Both check settings as on the fleet: the cells run with the box modes
 * warn and on (mantle.actor_check, mantle.edit_check).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/admin-membership.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('S8a: an Admin login is role AND membership', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  let session: typeof import('./session');
  let ws: typeof import('../workspaces');
  const tag = `s8a-${randomUUID().slice(0, 8)}`;
  const adm = randomUUID(); // role admin, in Admin
  const out = randomUUID(); // role admin, taken out of Admin (drift)
  const memIn = randomUUID(); // role member, put into Admin (drift)
  const mem = randomUUID(); // member, not in Admin
  const nobody = randomUUID(); // no login at all
  let anchor = '';
  const PASSWORD = 'first password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = async (path: string, init: { cookie?: string } = {}) => {
    ip += 1;
    const headers: Record<string, string> = { 'x-forwarded-for': `203.0.113.${ip % 250}` };
    if (init.cookie) headers.cookie = init.cookie;
    const res = await app.request(path, { method: 'GET', headers });
    return `${res.status} ${await res.text()}`;
  };
  const cookieAt = (id: string) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch: 0 }).value}`;
  const renderAt = (id: string) =>
    `mantle_render=${tokens.buildRenderToken({ ownerId: anchor, actorId: id, nodeId: randomUUID() })}`;
  /** An owner byte route on a node that is not there: past the gate it is
   *  the handler's 404, refused it is the gate's 401. */
  const fileBytes = () => `/api/files/files/${randomUUID()}`;
  const assetAnswer = (id: string) =>
    call(`${fileBytes()}?at=${tokens.buildAssetToken(anchor, id, 0)}`);
  const status = (answer: string) => Number(answer.slice(0, 3));
  /** A member route a member gets past (its handler's answer). */
  const memberProbe = async (cookie: string) =>
    status(await call('/api/member/push/preferences', { cookie }));
  /** An owner route: an Admin login gets past the gate. */
  const ownerProbe = async (cookie: string) =>
    status(await call('/api/pending/not-a-uuid', { cookie }));
  const caller = (loginId: string) => ({
    kind: 'admin' as const,
    loginId,
    anchorId: anchor,
    user: null,
  });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'admin-membership-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    session = await import('./session');
    ws = await import('../workspaces');
    anchor = await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${out}, ${emailOf(out)}, ${hash}, 'admin'),
      (${memIn}, ${emailOf(memIn)}, ${hash}, 'member'), (${mem}, ${emailOf(mem)}, ${hash}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    // The drift the precondition counts (mantle_role_drift): a role=admin
    // login taken out of Admin and a role=member login put into it.
    const [a] = await sql<Row[]>`select id::text as id from workspaces
                                  where owner_id = ${anchor} and is_admin`;
    await sql`delete from workspace_users where workspace_id = ${a!.id as string} and login_id = ${out}`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
              values (${a!.id as string}, ${memIn}, false) on conflict do nothing`;
    expect(Number((await sql<Row[]>`select mantle_role_drift() as n`)[0]!.n)).toBe(2);
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('the box count: brains without an Admin workspace is 0 (the S8a precondition)', async () => {
    // The SQL of scripts/arch-scoreboard-box.sh (no_admin), as the fleet reads it.
    const [r] = await sql<Row[]>`
      select count(*)::int as n from auth.users o
       where o.is_owner
         and not exists (select 1 from public.workspaces w
                          where w.owner_id = o.id and w.is_admin and w.archived_at is null)`;
    expect(r!.n).toBe(0);
    expect(
      Number((await sql<Row[]>`select count(*) as n from auth.users where is_owner`)[0]!.n),
    ).toBe(1);
  });

  it('a role=admin login outside Admin loses the asset token (the named narrowing)', async () => {
    expect(status(await assetAnswer(adm))).toBe(404); // an Admin user: past the gate
    expect(await assetAnswer(out)).toBe(await assetAnswer(nobody));
    expect(status(await assetAnswer(out))).toBe(401);
  });

  it('a role=admin login outside Admin loses the render cookie (the named narrowing)', async () => {
    expect(status(await call(fileBytes(), { cookie: renderAt(adm) }))).toBe(404);
    const refused = await call(fileBytes(), { cookie: renderAt(nobody) });
    expect(status(refused)).toBe(401);
    expect(await call(fileBytes(), { cookie: renderAt(out) })).toBe(refused);
  });

  it('a role=admin login outside Admin keeps its session but is not Admin', async () => {
    // Its session, as on main: past the owner gate, as the Admin user is.
    expect(await ownerProbe(cookieAt(adm))).not.toBe(401);
    expect(await ownerProbe(cookieAt(out))).toBe(await ownerProbe(cookieAt(adm)));
    // Not Admin: an Admin area route (users) refuses it, the Admin user not.
    expect(status(await call('/api/users', { cookie: cookieAt(adm) }))).toBe(200);
    const area = await call('/api/users', { cookie: cookieAt(out) });
    expect(status(area)).toBe(403);
    expect(area).toContain('"area"');
    // No asset token, no render cookie, no frame re-check.
    expect(status(await assetAnswer(out))).toBe(401);
    expect(status(await call(fileBytes(), { cookie: renderAt(out) }))).toBe(401);
    expect(await session.adminLoginActive(adm)).toBe(true);
    expect(await session.adminLoginActive(out)).toBe(false);
  });

  it('a role=member login inside Admin is not Admin: it stays a member', async () => {
    // The member gate lets it in, as any member.
    expect(await memberProbe(cookieAt(memIn))).toBe(await memberProbe(cookieAt(mem)));
    expect(await memberProbe(cookieAt(memIn))).not.toBe(401);
    // The owner gate refuses it as it refuses any member.
    expect(await call('/api/pending/not-a-uuid', { cookie: cookieAt(memIn) })).toBe(
      await call('/api/pending/not-a-uuid', { cookie: cookieAt(mem) }),
    );
    expect(await session.adminLoginActive(memIn)).toBe(false);
  });

  it('member-negative: no Admin answer for a non-Admin token, byte for byte', async () => {
    // The byte route serves members too (getReaderForAsset: a member `?at=`
    // token, the member's own reader): a role=member login inside Admin
    // answers as any member, and the drift admin and an outsider as a
    // random uuid's token.
    const random = await assetAnswer(randomUUID());
    expect(status(random)).toBe(401);
    for (const id of [out, nobody]) expect(await assetAnswer(id), id).toBe(random);
    expect(await assetAnswer(memIn)).toBe(await assetAnswer(mem));
    // The render cookie is the Admin login's only: refused for all of them.
    const randomRender = await call(fileBytes(), { cookie: renderAt(randomUUID()) });
    expect(status(randomRender)).toBe(401);
    for (const id of [mem, memIn, out, nobody]) {
      expect(await call(fileBytes(), { cookie: renderAt(id) }), id).toBe(randomRender);
    }
  });

  it('requireArea: unscoped the area rule, in its own scope the scope`s rule, another login`s throws', async () => {
    // Unscoped (system work): mantle_area_rule about the login.
    expect(await ws.requireArea(caller(adm), 'users')).toBe(true);
    expect(await ws.requireArea(caller(out), 'users')).toBe(false);
    expect(await ws.requireArea(caller(mem), 'users')).toBe(false);
    // In the login's own scope: mantle_scope_has_area.
    expect(await m.withViewer({ login: adm }, () => ws.requireArea(caller(adm), 'keys'))).toBe(
      true,
    );
    expect(await m.withViewer({ login: mem }, () => ws.requireArea(caller(mem), 'keys'))).toBe(
      false,
    );
    // In a scope for another login: a programming error, never an answer.
    await expect(
      m.withViewer({ login: mem }, () => ws.requireArea(caller(adm), 'keys')),
    ).rejects.toThrow(/another login/);
  });

  it('areasFor is mantle_login_areas (the strict rule)', async () => {
    for (const id of [adm, out, memIn, mem, nobody]) {
      const [r] = await sql<Row[]>`select mantle_login_areas(${id}::uuid) as a`;
      expect(await ws.areasFor(caller(id)), id).toEqual(r!.a);
    }
    expect(await ws.areasFor(caller(out))).toEqual([]);
  });
});

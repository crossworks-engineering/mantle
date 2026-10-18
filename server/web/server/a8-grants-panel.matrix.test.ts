/**
 * The grants panel's database rule as a second line (A8 fix round 1,
 * finding 8). The panel (server/web/lib/grants.ts) decides each change in
 * TypeScript first (mayManage, isMod), then makes it through the definers
 * (mantle_grant_change, mantle_grant_move_home: 0279) under the item's heads
 * (withHeads, so withSystemTx). Here the TypeScript decision is made wrong
 * on purpose: the panel's own read of the caller's seats (loadCtx:
 * workspaces joined to workspace_users) is answered with a Moderator seat of
 * the item's home that the caller does not hold, so the check allows. The
 * caller is a member: a user of W (Write on) and a Moderator of T, no seat
 * in H. The question: does the database still refuse, and leave the row as
 * it was?
 *
 * Two paths, each in the actor check modes a process runs in (off, warn, on;
 * MANTLE_ACTOR_CHECK raises the box's), with a control per change (the true
 * seats: TypeScript refuses, the database is not reached):
 *  - route: as the product runs it, POST /api/grants/:id and
 *    /api/grants/move through createApp. The grants routes are any-login
 *    rows (lib/auth/any-login-routes.ts): the gate enters the member's
 *    scope, and the panel's writes run in it (A6: before A6 grantsRoute
 *    left it by name, so the definers saw no scope to hold the change to);
 *  - scope: the same panel call in the member's own mutating request scope
 *    (the gate's enterLoginScope for a member's write: its seats, writes
 *    on). Before A6 the panel could not run there (its first read, the
 *    Admin workspace's row, was hidden from a member's scope: 409 "not set
 *    up"), so that read is answered too where the scope hides it; since A6
 *    it is a definer (mantle_ws_admin_id) and the scope reads it.
 * The answers are pinned; docs/actors.md, "A8 matrix", reports them (F7).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** What the panel's reads are answered with, when set: extra seats for the
 *  caller, and the Admin workspace's id where the scope hides its row. */
const h = vi.hoisted(() => ({
  lie: null as null | { seats: { id: string; moderator: boolean }[]; adminWs: string | null },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  const textOf = (q: unknown): string => {
    try {
      return dialect.sqlToQuery(q as never).sql;
    } catch {
      return '';
    }
  };
  // loadCtx's two statements: the Admin workspace (before A6 a plain read
  // a member's scope hid; a definer since, which this no longer matches),
  // the caller's seats.
  const ADMIN_READ = /select id from workspaces where owner_id = \$1 and is_admin/;
  const SEATS_READ = /join workspace_users u on u\.workspace_id = w\.id and u\.login_id/;
  type Row = { id: string; name: string; is_admin: boolean; moderator: boolean };
  const lying = <E extends object>(exec: E): E =>
    new Proxy(exec, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (prop !== 'execute' || typeof v !== 'function') {
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return async (q: unknown) => {
          const res = (await (v as (q: unknown) => Promise<unknown>).call(target, q)) as Row[];
          const lie = h.lie;
          if (!lie) return res;
          const sql = textOf(q);
          if (ADMIN_READ.test(sql) && res.length === 0 && lie.adminWs) {
            return [{ id: lie.adminWs }];
          }
          if (!SEATS_READ.test(sql)) return res;
          const out = new Map<string, Row>([...res].map((r) => [r.id, { ...r }]));
          for (const e of lie.seats) {
            out.set(e.id, { id: e.id, name: 'a8', is_admin: false, moderator: e.moderator });
          }
          return [...out.values()];
        };
      },
    });
  return {
    ...orig,
    db: lying(orig.db),
    withHeads: ((ids: string[], mode: never, fn: (tx: object) => Promise<unknown>) =>
      orig.withHeads(ids, mode, (tx) => fn(lying(tx as object)) as never)) as typeof orig.withHeads,
  };
});

describe.skipIf(!DB_URL)('A8: the grants panel’s database rule under a wrong TS decision', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let grants: typeof import('@/lib/grants');
  let runRoute: typeof import('./run-route').runRoute;
  let fx: import('@mantle/db/matrix/a8-grid').A8Fixture;
  let g: typeof import('@mantle/db/matrix/a8-grid');
  let dir = '';

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a8-grants-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a8-grants-panel-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A8 grants panel test', { status: 503 })),
    );
    m = await import('@mantle/db');
    g = await import('@mantle/db/matrix/a8-grid');
    grants = await import('@/lib/grants');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    fx = await g.buildA8Fixture(raw);
    await g.installProbe(raw);
    // The box at off: each case raises the process's mode itself
    // (MANTLE_ACTOR_CHECK only makes it stricter).
    await raw`select mantle_set_actor_check('off', 50, 'test')`;
  }, 300_000);

  afterAll(async () => {
    delete process.env.MANTLE_ACTOR_CHECK;
    vi.unstubAllGlobals();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  type Change = 'add' | 'move';
  type Path = 'route' | 'scope';
  type Answer = { outcome: 'made' | 'refused'; by: string };

  const probe = async (id: string) =>
    (await raw<{ p: string }[]>`select a8_probe(${id}::uuid) as p`)[0]!.p;

  /** The panel call in the member's mutating request scope. */
  const inScope = (change: Change, id: string): Promise<unknown> =>
    m.runInRequestSlot(async () => {
      const scope = await m.loginScopeFor(fx.logins.writeGrant);
      if (!m.enterRequestScope(scope, { writes: true, drafts: true })) {
        throw new Error('no request slot');
      }
      const caller = {
        kind: 'member',
        loginId: fx.logins.writeGrant,
        anchorId: fx.owner,
        user: null,
      } as never;
      return change === 'add'
        ? grants.addGrant(caller, id, { wsId: fx.ws.T, confirm: true })
        : grants.moveItems(caller, { nodeIds: [id], toWorkspaceId: fx.ws.T, confirm: true });
    });

  /** The panel call as the product makes it: the route, as the member. */
  const byRoute = async (change: Change, id: string): Promise<unknown> => {
    const res = await runRoute(
      fx.logins.writeGrant,
      'POST',
      change === 'add' ? `/api/grants/${id}` : '/api/grants/move',
      change === 'add'
        ? { wsId: fx.ws.T, write: false, confirm: true }
        : { nodeIds: [id], toWorkspaceId: fx.ws.T, confirm: true },
      { headers: { 'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.1` } },
    );
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  };

  /** One change; `lie`: H's seat claimed to the panel's TypeScript. */
  const attempt = async (change: Change, via: Path, lie: boolean): Promise<Answer> => {
    const item = await g.makeA8Item(raw, fx, 'note', 'root');
    const before = await probe(item.id);
    h.lie = lie
      ? { seats: [{ id: fx.ws.H, moderator: true }], adminWs: via === 'scope' ? fx.ws.admin : null }
      : via === 'scope'
        ? { seats: [], adminWs: fx.ws.admin }
        : null;
    let by: string;
    try {
      const res = await (via === 'route' ? byRoute(change, item.id) : inScope(change, item.id));
      by = `answered ${JSON.stringify(res).slice(0, 300)}`;
    } catch (err) {
      const e = err as { code?: string; status?: number; message?: string; cause?: unknown };
      const cause = e.cause as { code?: string; message?: string } | undefined;
      by =
        e.status !== undefined
          ? `GrantError ${e.status} ${e.message ?? ''}`
          : `thrown ${e.code ?? cause?.code ?? '?'} ${(cause?.message ?? e.message ?? '').slice(0, 200)}`;
    } finally {
      h.lie = null;
    }
    return { outcome: (await probe(item.id)) === before ? 'refused' : 'made', by };
  };

  for (const mode of ['off', 'warn', 'on'] as const) {
    it(`check ${mode}: a member who may not manage the item, the panel told it may`, async () => {
      process.env.MANTLE_ACTOR_CHECK = mode;
      m.takeActorMisses();
      const seen: Record<string, Answer> = {};
      for (const via of ['route', 'scope'] as const) {
        for (const change of ['add', 'move'] as const) {
          // The control: the true seats, TypeScript refuses, nothing made.
          const control = await attempt(change, via, false);
          expect(control.outcome, `${via} ${change} control: ${control.by}`).toBe('refused');
          expect(control.by, `${via} ${change} control`).toMatch(/403|moved\\*":0/);
          const lied = await attempt(change, via, true);
          // Refused by the database, not by the panel's TypeScript (which
          // the claimed seat lets through): the route answers the one
          // refusal mapper's item-workspace 403, the scope throws 42501.
          if (lied.outcome === 'refused') {
            expect(lied.by, `${via} ${change}: the database's refusal`).toMatch(
              via === 'route' ? /"status":403.*item-workspace/ : /^thrown 42501 /,
            );
          }
          seen[`${via} ${change}`] = lied;
        }
      }
      // The misses logged (warn's staged refusals), taken here so they are
      // reported and pinned, not the setup's generic failure.
      const misses = m.takeActorMisses();
      console.log(
        [
          `A8 grants panel, check ${mode} (member writeGrant, H's seat claimed in TypeScript):`,
          ...Object.entries(seen).map(([c, a]) => `  ${c} to T: ${a.outcome} (${a.by})`),
          `  actor misses: ${misses.length} ${JSON.stringify(misses).slice(0, 600)}`,
        ].join('\n'),
      );
      expect(misses.length, JSON.stringify(misses)).toBe(MISSES[mode]);
      // Pinned as found (docs/actors.md, "A8 matrix", the grants panel).
      expect(
        Object.fromEntries(Object.entries(seen).map(([c, a]) => [c, a.outcome])),
        JSON.stringify(seen, null, 1),
      ).toEqual(EXPECTED[mode]);
    }, 120_000);
  }
});

/**
 * What the database does with the wrong TypeScript decision (finding F7 in
 * docs/actors.md, fixed by A6): refused on both paths in every mode.
 *  - route, the product's path: the panel's writes run in the member's
 *    scope (A6 F7 a), so mantle_grant_change and mantle_grant_move_home
 *    hold the change to it, and the one refusal mapper answers 403
 *    item-workspace. Before A6: made in every mode (grantsRoute left the
 *    scope by name, inRuleInQuery, and mantle_grant_refuses asked for an
 *    active scope);
 *  - scope: refused (42501) in every mode: mantle_grant_refuses (0291)
 *    refuses whenever a scope is set, warn included (A6 F7 b). Before A6:
 *    refused with the check off and on, made in warn (the write role's own
 *    pass staged its refusals).
 */
const REFUSED = {
  'route add': 'refused',
  'route move': 'refused',
  'scope add': 'refused',
  'scope move': 'refused',
} as const;
const EXPECTED: Record<'off' | 'warn' | 'on', Record<string, 'made' | 'refused'>> = {
  off: REFUSED,
  warn: REFUSED,
  on: REFUSED,
};

/** The misses a run of the cases above logs: in warn, the database's own
 *  "refused when the check is on" for each refused add and move, on the
 *  route and in the scope (warn still reports the miss; it refuses too since
 *  A6). Before A6: 3, the scope path's add, its move and the move's
 *  workspace event, all made. Off reports the same 4 since plan v3 S3: a
 *  scoped write runs on the write role in every mode, and off reports what
 *  on would refuse, as warn (docs/actors.md, "The three routes to
 *  Postgres"; changed answer 1 of docs/_archive/plan-v3-s3-handover.md); before S3, 0 (the system pool). */
const MISSES: Record<'off' | 'warn' | 'on', number> = { off: 4, warn: 4, on: 0 };

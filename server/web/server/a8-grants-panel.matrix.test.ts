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
 *    rows (lib/auth/any-login-routes.ts): the request runs on the system
 *    pool with no scope, so the definers see no scope to hold the change to;
 *  - scope: the same panel call in the member's own mutating request scope
 *    (the gate's enterLoginScope for a member's write: its seats, writes
 *    on), where the definers do hold it to the scope. The panel cannot run
 *    there today (its first read, the Admin workspace's row, is hidden from
 *    a member's scope: 409 "not set up"), so that read is answered too.
 * The answers are pinned as found; docs/actors.md, "A8 matrix", reports
 * them.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';

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
  // loadCtx's two statements: the Admin workspace, the caller's seats.
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
  const kinds = ITEM_KIND_NAMES.filter((k) => ITEM_KINDS[k].class === 'workspace');
  const rootOf = (kind: string): string => {
    if (kind === 'branch') return 'notes';
    const tree = (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]!.tree;
    if (!tree) throw new Error(`no tree root for ${kind}`);
    return tree.root;
  };

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
    delete process.env.MANTLE_ADMIN_READS;
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
    fx = await g.buildA8Fixture(raw, kinds, rootOf);
    await g.installProbe(raw);
    // The box at off: each case raises the process's mode itself
    // (MANTLE_ACTOR_CHECK only makes it stricter).
    await raw`select mantle_set_actor_check('off')`;
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
    let by = '';
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
      const seen: Record<string, Answer> = {};
      for (const via of ['route', 'scope'] as const) {
        for (const change of ['add', 'move'] as const) {
          // The control: the true seats, TypeScript refuses, nothing made.
          const control = await attempt(change, via, false);
          expect(control.outcome, `${via} ${change} control: ${control.by}`).toBe('refused');
          expect(control.by, `${via} ${change} control`).toMatch(/403|moved\\*":0/);
          seen[`${via} ${change}`] = await attempt(change, via, true);
        }
      }
      console.log(
        [
          `A8 grants panel, check ${mode} (member writeGrant, H's seat claimed in TypeScript):`,
          ...Object.entries(seen).map(([c, a]) => `  ${c} to T: ${a.outcome} (${a.by})`),
        ].join('\n'),
      );
      // Pinned as found (docs/actors.md, "A8 matrix", the grants panel).
      expect(
        Object.fromEntries(Object.entries(seen).map(([c, a]) => [c, a.outcome])),
        JSON.stringify(seen, null, 1),
      ).toEqual(EXPECTED[mode]);
    }, 120_000);
  }
});

/**
 * What the database does today with the wrong TypeScript decision (A8 fix
 * round 1, finding F7 in docs/actors.md):
 *  - route, the product's path: made in every mode. The any-login row runs
 *    the panel on the system pool with no scope, so mantle_grant_change and
 *    mantle_grant_move_home hold nothing (mantle_grant_refuses asks for an
 *    active scope): the panel's rules are TypeScript only;
 *  - scope: refused (42501) with the check off and on; made in warn, where
 *    the write role's refusal is staged and the checked rerun on the system
 *    pool lets it through with a gap logged (warn's design), so warn holds
 *    less here than off.
 */
const ROUTE_MADE = { 'route add': 'made', 'route move': 'made' } as const;
const EXPECTED: Record<'off' | 'warn' | 'on', Record<string, 'made' | 'refused'>> = {
  off: { ...ROUTE_MADE, 'scope add': 'refused', 'scope move': 'refused' },
  warn: { ...ROUTE_MADE, 'scope add': 'made', 'scope move': 'made' },
  on: { ...ROUTE_MADE, 'scope add': 'refused', 'scope move': 'refused' },
};

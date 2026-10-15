/**
 * The grants panel's database rule as a second line (A8 fix round 1,
 * finding 8). The panel (server/web/lib/grants.ts) decides each change in
 * TypeScript first (mayManage, isMod), then makes it through the definers
 * (mantle_grant_change, mantle_grant_move_home: 0279) under the item's heads
 * (withHeads, so withSystemTx and the login write gateway). Here the
 * TypeScript decision is made wrong on purpose: the panel's own read of the
 * caller's seats (loadCtx: workspaces joined to workspace_users) is answered
 * with a Moderator seat of the item's home the caller does not hold, so the
 * check allows. The caller is a member in its own mutating request scope
 * (the gate's enterLoginScope: its seats, writes on). The question: does the
 * database still refuse, and leave the row as it was?
 *
 * Asked in each actor check mode the process can run in (off, warn, on: the
 * box mode MANTLE_ACTOR_CHECK raises), with a control per change (the true
 * seats: TypeScript refuses, the database is not reached). The answers are
 * pinned as they are today; docs/actors.md, "A8 matrix", reports them.
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

/** The seats the panel's read of the caller is answered with, when set. */
const h = vi.hoisted(() => ({
  lie: null as null | { loginId: string; extra: { id: string; moderator: boolean }[] },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  // loadCtx's one statement: the caller's live workspaces and seats.
  const isSeatsRead = (q: unknown): boolean => {
    try {
      return /join workspace_users u on u\.workspace_id = w\.id and u\.login_id/.test(
        dialect.sqlToQuery(q as never).sql,
      );
    } catch {
      return false;
    }
  };
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
          if (!h.lie || !isSeatsRead(q)) return res;
          const out = new Map<string, Row>([...res].map((r) => [r.id, { ...r }]));
          for (const e of h.lie.extra) {
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
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    g = await import('@mantle/db/matrix/a8-grid');
    grants = await import('@/lib/grants');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    fx = await g.buildA8Fixture(raw, kinds, rootOf);
    await g.installProbe(raw);
    // The box at off: each case raises the process's mode itself
    // (MANTLE_ACTOR_CHECK only makes it stricter).
    await raw`select mantle_set_actor_check('off')`;
  }, 300_000);

  afterAll(async () => {
    delete process.env.MANTLE_ACTOR_CHECK;
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** The member: a user of W (Write on), a Moderator of T; no seat in H. */
  const member = () => ({
    kind: 'member' as const,
    loginId: fx.logins.writeGrant,
    anchorId: fx.owner,
    user: null,
  });

  /** `fn` in the member's mutating request scope, as the gate enters it. */
  const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
    m.runInRequestSlot(async () => {
      const scope = await m.loginScopeFor(fx.logins.writeGrant);
      if (!m.enterRequestScope(scope, { writes: true, drafts: true })) {
        throw new Error('no request slot');
      }
      return fn();
    });

  type Answer = { outcome: 'made' | 'refused'; by: string; state: string };

  const probe = async (id: string) =>
    (await raw<{ p: string }[]>`select a8_probe(${id}::uuid) as p`)[0]!.p;

  /** One change as the panel makes it; `lie`: the seat of H claimed. */
  const attempt = async (
    change: 'add' | 'move',
    lie: boolean,
  ): Promise<Answer & { before: string }> => {
    const item = await g.makeA8Item(raw, fx, 'note', 'root');
    const before = await probe(item.id);
    h.lie = lie
      ? { loginId: fx.logins.writeGrant, extra: [{ id: fx.ws.H, moderator: true }] }
      : null;
    let by = '';
    try {
      const res = await asMember<unknown>(() =>
        change === 'add'
          ? grants.addGrant(member() as never, item.id, { wsId: fx.ws.T, confirm: true })
          : grants.moveItems(
              member() as never,
              {
                nodeIds: [item.id],
                toWorkspaceId: fx.ws.T,
                confirm: true,
              } as never,
            ),
      );
      by = `answered: ${JSON.stringify(res).slice(0, 300)}`;
    } catch (err) {
      const e = err as { code?: string; status?: number; message?: string; cause?: unknown };
      const cause = e.cause as { code?: string; message?: string } | undefined;
      by =
        e.status !== undefined
          ? `GrantError ${e.status} ${e.message ?? ''}`
          : `db ${e.code ?? cause?.code ?? '?'} ${(cause?.message ?? e.message ?? '').slice(0, 200)}`;
    } finally {
      h.lie = null;
    }
    const state = await probe(item.id);
    return { outcome: state === before ? 'refused' : 'made', by, state, before };
  };

  for (const mode of ['off', 'warn', 'on'] as const) {
    it(`check ${mode}: a member who may not manage the item, the panel told it may`, async () => {
      process.env.MANTLE_ACTOR_CHECK = mode;
      m.takeActorMisses();
      const seen: Record<string, Answer> = {};
      for (const change of ['add', 'move'] as const) {
        // The control: the true seats, TypeScript refuses (403), nothing made.
        const control = await attempt(change, false);
        expect(control.outcome, `${change} control: ${control.by}`).toBe('refused');
        expect(control.by, change).toMatch(/^GrantError 403|"moved":0/);
        seen[change] = await attempt(change, true);
      }
      const misses = m.takeActorMisses();
      console.log(
        [
          `A8 grants panel, check ${mode} (member writeGrant, H's seat claimed in TypeScript):`,
          ...Object.entries(seen).map(([c, a]) => `  ${c} to T: ${a.outcome} (${a.by})`),
          `  actor misses: ${misses.length}`,
        ].join('\n'),
      );
      // Pinned as found (docs/actors.md, "A8 matrix", the grants panel).
      expect({ add: seen.add!.outcome, move: seen.move!.outcome }).toEqual(EXPECTED[mode]);
    }, 120_000);
  }
});

/** What the database does today with the wrong TypeScript decision. */
const EXPECTED: Record<'off' | 'warn' | 'on', { add: string; move: string }> = {
  off: { add: 'refused', move: 'refused' },
  warn: { add: 'refused', move: 'refused' },
  on: { add: 'refused', move: 'refused' },
};

/**
 * The A8 route cells (plan v3.2 section 5 item 3): every write route whose
 * declaration names its item (`item: { param, need }`), through the full
 * HTTP pipeline (runRoute: the gate, the route row, the caller, the
 * handler), as the five roles of the plan (outsider, readGrant, writeGrant,
 * homeModerator, an Admin user; and, on a route open to Admin users only,
 * an Admin user with Write on the item and no Moderator seat of its home)
 * on each placement of its kind, with the actor check and the edit check in
 * warn and in on (plan rule 5). The cells are generated from the
 * declarations and the request each route takes (a8-route-cells.ts); the
 * fixture is the A8 grid's (a8-grid.ts), seeded once, and each cell gets a
 * fresh item of its kind and placement, with the content its route needs
 * (a8-tool-content.ts).
 *
 * A cell passes on the oracle's answer: allowed is a 2xx (a delete leaves
 * the item gone; a write changes what the probe sees); refused is a 403 or
 * a 404 that changes no row and makes no node, never a crash; and a caller
 * that does not read the item gets what a random uuid gets (status, body
 * with the id aside, content type, cache control). In warn the one change:
 * a route whose edit is the database's check alone (warnMade) makes the
 * edit of a login that reads the item and may not edit it, and logs it as
 * an actor miss; a delete, a hidden item and every handler's refusal hold.
 * Any other actor miss is the cell's failure. The route cells have no known
 * failures: each one passes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { A8RouteCell, A8RouteRole } from './test-support/a8-route-cells';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));
// The app's own SQLite (the fixture's app has none), as the tool cells.
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbQuery: vi.fn(async () => ({ rows: [] })),
  appDbExec: vi.fn(async () => ({ changes: 1 })),
}));
// The object store is outside the box: an app build puts its bundle there.
vi.mock('@mantle/storage/write', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putContent: async (body: Buffer) => {
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(body).digest('hex');
    return { key: `test/${sha256}`, sha256, size: body.length, deduped: false };
  },
}));

/** The time the route cells may take, both modes (the budget cell): a run
 *  on the workstation's test lane takes TIME_MEASURED; past the ceiling the
 *  cell fails, past the target it only warns (a loaded box is slower). */
const A8_ROUTE_TIME_TARGET_MS = 120_000;
const A8_ROUTE_TIME_CEILING_MS = 600_000;

describe.skipIf(!DB_URL)('A8 route cells: every item route gives the oracle’s answer', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let g: typeof import('@mantle/db/matrix/a8-grid');
  let tc: typeof import('@mantle/db/matrix/a8-tool-cells');
  let tc2: typeof import('@mantle/db/matrix/a8-tool-content');
  let rc: typeof import('./test-support/a8-route-cells');
  let runRoute: typeof import('./run-route').runRoute;
  let contentDeps: import('@mantle/db/matrix/a8-tool-content').A8ContentDeps;
  let actorMode: typeof import('../../../packages/db/src/actor');
  let fx: import('@mantle/db/matrix/a8-grid').A8Fixture;
  let manifest: readonly import('./test-support/a8-route-cells').A8ManifestEntry[];
  let dir = '';
  /** Each role's read-write API key (the /api/v1 routes). */
  const keyRw: Partial<Record<A8RouteRole, string>> = {};
  /** The Admin user with Write on the item through W (A8_ADMIN_WRITE_GRANT). */
  const adminWriteGrant = randomUUID();
  const loginOf = (role: A8RouteRole) =>
    role === 'adminWriteGrant' ? adminWriteGrant : fx.logins[role];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a8-routes-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a8-route-cells-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    // The app build reads the app runtime's exports map: a stub of its own.
    await mkdir(path.join(dir, 'runtime'), { recursive: true });
    await writeFile(
      path.join(dir, 'runtime', 'manifest.json'),
      JSON.stringify({
        exports: {
          '@host': ['host'],
          react: ['default', 'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback'],
          'react/jsx-runtime': ['jsx', 'jsxs', 'Fragment'],
        },
      }),
    );
    process.env.MANTLE_APP_RUNTIME_MANIFEST = path.join(dir, 'runtime', 'manifest.json');
    // Cost safety: nothing reaches out, and every model is fake.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A8 route cells', { status: 503 })),
    );
    m = await import('@mantle/db');
    g = await import('@mantle/db/matrix/a8-grid');
    tc = await import('@mantle/db/matrix/a8-tool-cells');
    tc2 = await import('@mantle/db/matrix/a8-tool-content');
    rc = await import('./test-support/a8-route-cells');
    runRoute = (await import('./run-route')).runRoute;
    manifest = (await import('./route-manifest.gen')).routeManifest as never;
    const tdb = await import('@mantle/tabledb');
    const { writeDocFile } = await import('@mantle/tabledb/write');
    const { writeAppPackage } = await import('@mantle/content/app-package');
    const { appDbSeedRows } = await import('@mantle/content/app-broker');
    contentDeps = {
      filesRoot: process.env.MANTLE_FILES_ROOT!,
      writeWorkbook: (rel, wb, meta) =>
        writeDocFile(tdb.resolveStoragePath(rel), wb as never, { ...meta, fts: true }),
      snapshotWorkbook: (rel, srel) => {
        tdb.snapshotFile(tdb.resolveStoragePath(rel), tdb.resolveStoragePath(srel));
        return statSync(tdb.resolveStoragePath(srel)).size;
      },
      tableFile: (rel) => tdb.resolveStoragePath(rel),
      engineVersion: tdb.ENGINE_VERSION,
      writeAppPackage: async (appId, dest) => {
        await m.runAsSystem('test:a8-tool-content', () =>
          writeAppPackage(fx.owner, appId, dest, { withData: false }),
        );
      },
      appDbFile: (appId) => path.join(process.env.APP_DB_DIR!, fx.owner, `${appId}.sqlite`),
      seedAppDb: async (appId, schema) => {
        await m.runAsSystem('test:a8-tool-content', () =>
          appDbSeedRows(fx.owner, appId, 'a8', [{ v: 1 }], {}, schema),
        );
      },
    };
    actorMode = await import('../../../packages/db/src/actor');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    fx = await g.buildA8Fixture(raw);
    await g.installProbe(raw);
    await tc2.makeA8DropFolder(raw, fx);
    await raw`select mantle_set_actor_check('off', 50, 'test')`;
    // An Admin user who is a user of W (Write on), no Moderator of H.
    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
              values (${adminWriteGrant}, ${`${fx.tag}-awg@example.invalid`}, 'x', false,
                      'admin', 'adminWriteGrant')`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
              values (${fx.ws.admin}, ${adminWriteGrant}, true),
                     (${fx.ws.W}, ${adminWriteGrant}, false)
              on conflict do nothing`;
    const keys = await import('../lib/access-keys');
    for (const role of [...rc.A8_ROUTE_ROLES, rc.A8_ADMIN_WRITE_GRANT]) {
      const login = loginOf(role);
      const minted = await m.asSystem(
        () =>
          keys.mintAccessKey({
            name: `${fx.tag} ${role} read_write`,
            loginId: login,
            access: 'read_write',
            areas: null,
            riskyTools: [],
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
            createdBy: login,
            maxLive: 50,
          }),
        'test',
      );
      keyRw[role] = minted!.key;
    }
    m.takeActorMisses();
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

  /** The item's row (a8_probe), its content and the brain's node count. */
  const probe = async (id: string) => {
    const [r] = await raw<{ p: string; n: number }[]>`
      select a8_probe(${id}::uuid) as p, (select count(*)::int from nodes) as n`;
    return {
      row: r!.p,
      content: await tc2.a8ContentProbe(raw, id, contentDeps),
      nodes: r!.n,
    };
  };

  /** A fresh item of the cell's kind and placement, with its route's
   *  content (a tool's seed), and what its request is built from. */
  const freshItem = async (
    spec: import('./test-support/a8-route-cells').A8RouteSpec,
    placement: import('@mantle/db/matrix/guide-oracle').GuidePlacement,
  ) => {
    const seeded = spec.seed
      ? await tc2.seedA8ToolItem(raw, fx, contentDeps, {
          tool: spec.seed,
          kind: spec.kind,
          placement,
        })
      : null;
    if (spec.seed && !seeded) throw new Error(`no content seed ${spec.seed}`);
    const item = seeded?.item ?? (await g.makeA8Item(raw, fx, spec.kind, placement));
    // A snapshot copy is read only, to the fixture too: its content stays.
    if (spec.prepSql && placement !== 'snapshot') {
      await raw.begin(async (tx) => {
        await tx.unsafe(g.FIXTURE_ACTOR);
        await tx.unsafe(spec.prepSql!, [item.id]);
      });
    }
    const [v] = await raw<{ version: number }[]>`
      select version from recall_maps where id = ${item.id}`;
    const ctx: import('./test-support/a8-route-cells').A8RouteCtx = {
      id: item.id,
      tag: fx.tag,
      input: seeded?.input ?? {},
      version: v?.version ?? 0,
      ws: fx.ws,
      folderId: placement === 'folder' ? fx.folders[spec.kind]!.id : null,
    };
    return ctx;
  };

  const call = async (
    role: A8RouteRole,
    spec: import('./test-support/a8-route-cells').A8RouteSpec,
    method: string,
    p: string,
    ctx: import('./test-support/a8-route-cells').A8RouteCtx,
  ): Promise<import('./test-support/a8-route-cells').A8RouteOutcome> => {
    try {
      const login = spec.key ? { key: keyRw[role]! } : loginOf(role);
      const raw = spec.raw?.(ctx);
      const res = raw
        ? await runRoute(login, method, p, undefined, {
            rawBody: raw.body,
            headers: { 'content-type': raw.type },
          })
        : await runRoute(login, method, p, spec.body?.(ctx));
      return {
        status: res.status,
        text: await res.text(),
        contentType: res.headers.get('content-type'),
        cacheControl: res.headers.get('cache-control'),
      };
    } catch (err) {
      return {
        status: 599,
        text: `thrown: ${String(err)}`,
        contentType: null,
        cacheControl: null,
      };
    }
  };

  it('every cell gives the oracle’s answer, in check modes warn and on', async () => {
    const plan = rc.a8RoutePlan(manifest);
    const routes = new Map(rc.a8ItemRoutes(manifest).map((r) => [r.key, r]));
    expect(plan.uncovered, 'routes that name their item and have no cells').toEqual({});
    const started = Date.now();
    const lines: string[] = [];
    const unexpected: string[] = [];
    /** Each route's allowed cells run and passed, by mode. */
    const allowedRuns = new Map<string, { ran: number; passed: number }>();
    for (const mode of rc.A8_ROUTE_MODES) {
      await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
      await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
      process.env.MANTLE_ACTOR_CHECK = mode;
      actorMode.noteBoxActorCheckMode(mode);
      expect(m.actorCheckMode()).toBe(mode);
      const modeStarted = Date.now();
      const failures = new Map<string, string>();
      /** The routes whose refused edit warn made (and logged). */
      const warnMade = new Set<string>();
      for (const cell of plan.cells as A8RouteCell[]) {
        const spec = rc.a8CellSpec(cell);
        const route = routes.get(cell.key)!;
        const name = rc.a8RouteCellName(cell);
        let fail: string | null;
        try {
          const ctx = await freshItem(spec, cell.placement);
          const before = await probe(ctx.id);
          m.takeActorMisses();
          const out = await call(
            cell.role,
            spec,
            cell.method,
            rc.a8RoutePath(route, spec, ctx),
            ctx,
          );
          const misses = m.takeActorMisses();
          const after = await probe(ctx.id);
          let random: {
            out: import('./test-support/a8-route-cells').A8RouteOutcome;
            id: string;
          } | null = null;
          if (!rc.allows(cell.want) && !cell.reads) {
            const id = randomUUID();
            random = {
              id,
              out: await call(
                cell.role,
                spec,
                cell.method,
                rc.a8RoutePath(route, spec, ctx, id),
                ctx,
              ),
            };
            m.takeActorMisses();
          }
          fail = rc.judgeA8RouteCell({
            cell,
            spec,
            mode,
            out,
            misses: misses.length,
            before,
            after,
            random,
            itemId: ctx.id,
            generic: tc.A8_GENERIC,
          });
          if (fail && misses.length) fail += ` | misses: ${JSON.stringify(misses).slice(0, 160)}`;
          if (rc.a8WarnMade(cell, spec, mode) && !fail) warnMade.add(cell.key);
        } catch (err) {
          fail = `the cell threw: ${String(err).slice(0, 200)}`;
        }
        if (fail) failures.set(name, fail);
        if (rc.allows(cell.want)) {
          const k = `${cell.key} ${mode}`;
          const r = allowedRuns.get(k) ?? { ran: 0, passed: 0 };
          r.ran++;
          if (!fail) r.passed++;
          allowedRuns.set(k, r);
        }
      }
      unexpected.push(...[...failures].map(([n, r]) => `[check ${mode}] ${n}: ${r}`));
      lines.push(
        `A8 route cells, check ${mode}: ${plan.cells.length} cells in ` +
          `${((Date.now() - modeStarted) / 1000).toFixed(1)} s, ${failures.size} fail` +
          (mode === 'warn' ? `; made and logged in warn: ${[...warnMade].sort().join(', ')}` : ''),
        ...[...failures].map(([n, r]) => `  FAIL ${n}: ${r}`),
      );
    }
    const elapsed = Date.now() - started;
    const narrowed: Record<string, number> = {};
    for (const c of plan.cells) {
      if (c.narrowed) narrowed[c.narrowed] = (narrowed[c.narrowed] ?? 0) + 1;
    }
    console.log(
      [
        `A8 route cells: ${plan.cells.length} cells of ${plan.covered.length} routes ` +
          `(${Object.keys(plan.exempt).length} refused only) over ` +
          `${rc.A8_ROUTE_MODES.length} check modes in ${(elapsed / 1000).toFixed(1)} s`,
        ...Object.entries(narrowed).map(([why, n]) => `  narrowed ${n}: ${why}`),
        ...lines,
      ].join('\n'),
    );
    // No known failures: every route cell passes.
    expect(unexpected, 'route cells that fail').toEqual([]);
    // Every covered route's own work runs: an allowed cell in each mode,
    // and one passes.
    const noAllowed = plan.covered.flatMap((key) =>
      rc.A8_ROUTE_MODES.flatMap((mode) => {
        const r = allowedRuns.get(`${key} ${mode}`);
        if (!r?.ran) return [`${key} (check ${mode}): no allowed cell ran`];
        if (!r.passed) return [`${key} (check ${mode}): no allowed cell passed`];
        return [];
      }),
    );
    expect(noAllowed, 'routes whose own work never ran or never passed').toEqual([]);
    // The budget cell: the route cells stay inside their time (past the
    // target a warning only: a loaded box runs slower).
    if (elapsed > A8_ROUTE_TIME_TARGET_MS) {
      console.warn(
        `A8 route cells: ${(elapsed / 1000).toFixed(1)} s, past the ${A8_ROUTE_TIME_TARGET_MS / 1000} s target`,
      );
    }
    expect(elapsed, 'the route cells took longer than their ceiling').toBeLessThan(
      A8_ROUTE_TIME_CEILING_MS,
    );
  }, 3_600_000);
});

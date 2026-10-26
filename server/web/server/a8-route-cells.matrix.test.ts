/**
 * The A8 route cells (plan v3.2 section 5 item 3): every write route whose
 * declaration names its item (`item: { param, need }`), through the full
 * HTTP pipeline (runRoute: the gate, the route row, the caller, the
 * handler), as the five roles of the plan (outsider, readGrant, writeGrant,
 * homeModerator, an Admin user) on each placement of its kind, with the
 * actor check and the edit check on, as every fleet box runs them (in warn
 * the edit check lets through a write the database would refuse: see
 * A8_ROUTE_MODES). The cells are generated from the declarations and the request each
 * route takes (a8-route-cells.ts); the fixture is the A8 grid's
 * (a8-grid.ts), seeded once, and each cell gets a fresh item of its kind and
 * placement, with the content its route needs (a8-tool-content.ts).
 *
 * A cell passes on the oracle's answer: allowed is a 2xx (a delete leaves
 * the item gone; an edit changes what the probe sees); refused is a 403 or a
 * 404 that changes no row and makes no node, never a crash; and a caller
 * that does not read the item gets what a random uuid gets, byte for byte
 * (the id aside). Each cell's actor misses are its own failure. The route
 * cells have no known failures: each one passes.
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
import type { GuideRole } from '@mantle/db/matrix/guide-oracle';

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

/** The time the route cells may take (the budget cell): about 25 s on the
 *  workstation alone, so a loaded box has room and a slow cell still shows. */
const A8_ROUTE_TIME_CEILING_MS = 120_000;

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
  const keyRw: Partial<Record<GuideRole, string>> = {};

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
    const keys = await import('../lib/access-keys');
    for (const role of rc.A8_ROUTE_ROLES) {
      const login = fx.logins[role];
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
    };
    return ctx;
  };

  const call = async (
    role: GuideRole,
    spec: import('./test-support/a8-route-cells').A8RouteSpec,
    method: string,
    p: string,
    body: unknown,
  ) => {
    try {
      const res = await runRoute(
        spec.key ? { key: keyRw[role]! } : fx.logins[role],
        method,
        p,
        body,
      );
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 599, text: `thrown: ${String(err)}` };
    }
  };

  it('every cell gives the oracle’s answer, in check mode on', async () => {
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
      for (const cell of plan.cells) {
        const spec = rc.A8_ROUTE_SPECS[cell.key]!;
        const route = routes.get(cell.key)!;
        const name = rc.a8RouteCellName(cell);
        let fail: string | null;
        try {
          const ctx = await freshItem(spec, cell.placement);
          const body = spec.body?.(ctx);
          const before = await probe(ctx.id);
          m.takeActorMisses();
          const out = await call(
            cell.role,
            spec,
            cell.method,
            rc.a8RoutePath(route, spec, ctx),
            body,
          );
          const misses = m.takeActorMisses();
          const after = await probe(ctx.id);
          let random: { out: { status: number; text: string }; id: string } | null = null;
          if (!rc.allows(cell.want) && !cell.reads) {
            const id = randomUUID();
            random = {
              id,
              out: await call(
                cell.role,
                spec,
                cell.method,
                rc.a8RoutePath(route, spec, ctx, id),
                body,
              ),
            };
            m.takeActorMisses();
          }
          fail =
            rc.judgeA8RouteCell({
              cell,
              spec,
              out,
              before,
              after,
              random,
              itemId: ctx.id,
              generic: tc.A8_GENERIC,
            }) ?? (misses.length ? `actor miss: ${JSON.stringify(misses).slice(0, 160)}` : null);
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
          `${((Date.now() - modeStarted) / 1000).toFixed(1)} s, ${failures.size} fail`,
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
    // The budget cell: the route cells stay inside their time.
    expect(elapsed, 'the route cells took longer than their budget').toBeLessThan(
      A8_ROUTE_TIME_CEILING_MS,
    );
  }, 3_600_000);
});

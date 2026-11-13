/**
 * The maintenance worker collects this box's own status (box_status,
 * peer_status's own line) for the app timers it runs:
 *  - its boot (workers/maintenance.ts) installs the collector, as the web
 *    process's does (server/main.ts);
 *  - a peer_status timer run as the worker runs it (system(worker:
 *    maintenance), the tick) records this box's own line as ok, and every
 *    database probe of the collector answered on the route the timer's call
 *    takes (the narrow route after the settings area check, in the login's
 *    own scope): no `postgres`, `storage.attachments`, `spend`, `capacity`,
 *    `extraction`, `logins` or `embedder` in `degraded`. The runtime role suite runs it
 *    with the system pool on mantle_runtime;
 *  - without the collector the same run records `unavailable` (the bug
 *    this pins).
 * Nothing leaves the test: every outbound fetch answers 503.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/workers/maintenance-box-status.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The worker's shell: importing maintenance.ts runs its boot (the collector
// install) and hands its setup to runQueueWorker, which starts nothing here.
const runQueueWorker = vi.hoisted(() => vi.fn());
vi.mock('./_runner', () => ({ runQueueWorker }));

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The collector's probes that read the database (the embedder's reads its
 *  saved route first; its check itself answers at once here, the fetch
 *  stubbed). */
const DB_PROBES = [
  'postgres',
  'storage.attachments',
  'spend',
  'capacity',
  'extraction',
  'logins',
  'embedder',
];

type Line = { self?: true; ok: boolean; error?: string; status?: Record<string, unknown> };

describe.skipIf(!URL)('the maintenance worker: its own box status for the app timers', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let tools: typeof import('@mantle/tools');
  let broker: typeof import('@mantle/content/app-broker');
  let dir = '';
  const tag = `mbs${randomUUID().slice(0, 6)}`;
  const admin = randomUUID();
  const appId = randomUUID();
  let anchor = '';

  /** One tick as the worker runs it, the timer due now; this box's own line
   *  of the run it recorded. */
  async function tickOwnLine(): Promise<Line> {
    await su`update app_timers set next_run_at = now() - interval '1 minute', claim_id = null
      where app_node_id = ${appId}`;
    const tick = await m.runAsSystem('worker:maintenance', () =>
      tools.runDueAppTimers({ jitterMs: 0 }),
    );
    expect(tick).toMatchObject({ claimed: 1, ok: 1, failed: 0 });
    const rows = (await m.runAsSystem('test:maintenance-box-status', () =>
      broker.appDbQuery(
        anchor,
        appId,
        'SELECT ok, result, error FROM _timer_runs ORDER BY id DESC LIMIT 1',
      ),
    )) as { ok: number; result: string | null; error: string | null }[];
    expect(rows[0]).toMatchObject({ ok: 1, error: null });
    const out = JSON.parse(rows[0]!.result!) as { boxes: Line[] };
    const own = out.boxes.filter((b) => b.self);
    expect(own).toHaveLength(1);
    return own[0]!;
  }

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'maint-box-status-'));
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_FILES_ROOT = dir;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in this test', { status: 503 })),
    );
    su = ts.superuserClient(scratch.url);
    await su`insert into auth.users (id, email, password_hash, role, display_name)
      values (${admin}, ${`${tag}@example.invalid`}, 'x', 'admin', null)`;
    anchor = await ts.ensureTestAnchor(su);
    const adminWs = await ts.ensureAdminUsers(su, [admin]);
    m = await import('@mantle/db');
    await import('@mantle/tools/gate-narrowers');
    tools = await import('@mantle/tools');
    tools.ensureGateReady();
    broker = await import('@mantle/content/app-broker');
    await m.runAsSystem('test:maintenance-box-status', () => tools.seedBuiltinTools(anchor));
    // An app in the Admin workspace that declares peer_status, and a timer
    // an Admin user set on it (peer_status is a risky read: Admin users only).
    await m.runAsSystem('test:maintenance-box-status', async () => {
      await m.systemDb.execute(m.sql`insert into nodes (id, owner_id, type, title, path)
        values (${appId}, ${anchor}, 'app', ${`${tag} fleet`}, 'apps')`);
      await m.systemDb.execute(m.sql`insert into apps (node_id, manifest)
        values (${appId}, ${JSON.stringify({ toolSlugs: ['peer_status'] })}::jsonb)`);
      await m.withHeads([appId], 'update', (tx) =>
        tx.execute(m.sql`update item_grants set workspace_id = ${adminWs}
          where node_id = ${appId} and is_home`),
      );
    });
    await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, created_by)
      values (${anchor}, ${appId}, 'fleet', 'peer_status', ${admin})`;
    // pg-boss's job table, which the extractor's queue counts read: pg-boss
    // makes it at its first start (pgboss:init), after a scratch database's
    // migrate, so it stands in here with the grant migrate gives it on a box
    // (as narrow-area-sweep.db.test.ts does).
    await su`create table if not exists pgboss.job (
               id uuid primary key default gen_random_uuid(), name text not null,
               state text not null, data jsonb, output jsonb,
               created_on timestamptz not null default now(),
               completed_on timestamptz)`;
    await su`grant select on pgboss.job to mantle_runtime, mantle_system_narrow`;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    tools?.registerBoxStatusProvider(null);
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("the worker's boot installs the collector, then hands its setup to the runner", async () => {
    tools.registerBoxStatusProvider(null);
    await import('./maintenance');
    const { boxStatus } = await import('../lib/box-status');
    expect(tools.getBoxStatusProvider()).toBe(boxStatus);
    expect(runQueueWorker).toHaveBeenCalledWith('maintenance', expect.any(Function));
  });

  it("a peer_status timer run in the worker: this box's own line is ok, every database probe answered", async () => {
    const own = await tickOwnLine();
    expect(own, JSON.stringify(own)).toMatchObject({ self: true, ok: true });
    const status = own.status as {
      schema: number;
      postgres: { up: boolean };
      spend: unknown;
      capacity: unknown;
      extraction: unknown;
      logins: { total: number } | null;
      degraded: string[];
    };
    expect(status.schema).toBe(1);
    expect(status.postgres.up).toBe(true);
    expect(status.spend).not.toBeNull();
    expect(status.capacity).not.toBeNull();
    expect(status.extraction).not.toBeNull();
    expect(status.logins?.total).toBeGreaterThanOrEqual(2);
    for (const probe of DB_PROBES) expect(status.degraded, probe).not.toContain(probe);
  }, 60_000);

  it('without the collector (the worker before this fix), the same run records unavailable', async () => {
    const installed = tools.getBoxStatusProvider();
    tools.registerBoxStatusProvider(null);
    try {
      expect(await tickOwnLine()).toMatchObject({ self: true, ok: false, error: 'unavailable' });
    } finally {
      tools.registerBoxStatusProvider(installed);
    }
  }, 60_000);
});

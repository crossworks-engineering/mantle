/**
 * This box's status as numbers: the collector behind the box_status tool
 * (@mantle/tools builtins-box-status.ts, docs/federation.md "Status links").
 *
 * Built from what the dashboard already reads, never a second copy of it:
 * the system health (system-health.ts, with no paid embedder probe), the
 * spend (metrics.ts), the corpus capacity (@mantle/content corpusCapacity),
 * the extractor's queue (extraction-queue.ts) and the logins. Only numbers
 * and booleans leave: no table name, no host or user name, no agent or model
 * name, nothing a user wrote. Every part is timeout-bounded; one that fails
 * names itself in `degraded`, never fails the whole.
 *
 * Cached for 30 seconds, one collection at a time: many callers (an app's
 * timer, every watching box, the owner) cannot make it work harder than that.
 * Installed into the bridge at boot (installBoxStatusProvider) by the web
 * process (server/main.ts) and the maintenance worker, whose app timers call
 * peer_status and box_status (workers/maintenance.ts); a process without it
 * answers that it cannot. Each process keeps its own cache.
 */
import { sql } from 'drizzle-orm';
import { authUsers, db } from '@mantle/db';
import { corpusCapacity } from '@mantle/content';
import { NET_TIMEOUTS, TtlCache, withTimeout } from '@mantle/std';
import { APP_VERSION, BUILD_TIME, GIT_SHA } from '@mantle/client-types/version';
import { registerBoxStatusProvider, shapeBoxStatus, type BoxStatus } from '@mantle/tools';
import { readServicesFile, type ServicesFile } from '@mantle/config';
import type { BoxStatusView } from '@mantle/client-types';
import { getSystemHealth } from './system-health';
import { spendInRange, trafficWindow, turnCount } from './metrics';
import { extractionQueueCounts } from './extraction-queue';
import { loginRole } from './auth/admin-seat';

/** How long one collection is served to every caller. */
export const BOX_STATUS_TTL_MS = 30_000;

/** Logins by display role (enabled) and the disabled ones: counts only,
 *  counted in SQL (mantle_login_role, the display role: it decides
 *  nothing here). */
async function loginCounts(): Promise<NonNullable<BoxStatus['logins']>> {
  const role = loginRole(authUsers.id);
  const [r] = await db
    .select({
      admin: sql<number>`count(*) filter (where ${authUsers.disabledAt} is null and ${role} = 'admin')::int`,
      member: sql<number>`count(*) filter (where ${authUsers.disabledAt} is null and ${role} <> 'admin')::int`,
      disabled: sql<number>`count(*) filter (where ${authUsers.disabledAt} is not null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(authUsers);
  return {
    admin: r?.admin ?? 0,
    member: r?.member ?? 0,
    disabled: r?.disabled ?? 0,
    total: r?.total ?? 0,
  };
}

async function spendNumbers(ownerId: string): Promise<NonNullable<BoxStatus['spend']>> {
  const [day, week, month, traffic, turns] = await Promise.all([
    spendInRange(ownerId, 'day'),
    spendInRange(ownerId, 'week'),
    spendInRange(ownerId, 'month'),
    trafficWindow(ownerId, 24),
    turnCount(ownerId, 24),
  ]);
  return {
    last24hMicroUsd: day.costMicroUsd,
    last7dMicroUsd: week.costMicroUsd,
    last30dMicroUsd: month.costMicroUsd,
    traces24h: traffic.count,
    turns24h: turns,
    errors24h: traffic.errorCount,
  };
}

/** One collection, uncached. */
export async function collectBoxStatus(ownerId: string): Promise<BoxStatus> {
  const extraDegraded: string[] = [];
  async function part<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await withTimeout(fn(), NET_TIMEOUTS.healthVital, name);
    } catch {
      extraDegraded.push(name);
      return null;
    }
  }
  const [health, spend, capacity, extraction, logins] = await Promise.all([
    getSystemHealth(ownerId, { probeRemoteEmbedder: false }),
    part('spend', () => spendNumbers(ownerId)),
    part('capacity', () => corpusCapacity(ownerId)),
    part('extraction', () => extractionQueueCounts()),
    part('logins', () => loginCounts()),
  ]);
  const disk = health.host.disk;
  return {
    schema: 1,
    ts: health.ts,
    build: { version: APP_VERSION, gitSha: GIT_SHA || null, buildTime: BUILD_TIME || null },
    process: {
      uptimeSec: Math.round(health.host.uptimeSec),
      heapUsedBytes: health.host.heapUsedBytes,
      rssBytes: health.host.rssBytes,
    },
    host: {
      scope: health.scope,
      cpuLoadPct: health.host.cpuLoadPct,
      loadAvg: [
        health.host.loadAvg[0] ?? 0,
        health.host.loadAvg[1] ?? 0,
        health.host.loadAvg[2] ?? 0,
      ],
      cores: health.host.cpuCores,
      mem: health.host.mem,
      disk: disk
        ? {
            usedBytes: disk.usedBytes,
            totalBytes: disk.totalBytes,
            freeBytes: Math.max(0, disk.totalBytes - disk.usedBytes),
            usedPct: disk.usedPct,
          }
        : null,
    },
    postgres: {
      up: health.postgres.up,
      dbSizeBytes: health.postgres.dbSizeBytes,
      connections: health.postgres.connections,
      cacheHitPct: health.postgres.cacheHitPct,
    },
    services: {
      objectStore: health.storage.objectStoreUp,
      parser: {
        up: health.parser.up,
        running: health.parser.running,
        queued: health.parser.queued,
      },
      browser: health.browser.up,
      documents: health.documents?.up ?? null,
      embedder: health.embedder.up,
      sandboxes: health.sandboxes.up,
      network: health.network.up,
    },
    spend,
    capacity: capacity
      ? {
          docs: capacity.docs.count,
          chunkVectors: capacity.chunkVectors.count,
          zone: capacity.zone,
          pctOfSplit: capacity.pctOfSplit,
        }
      : null,
    extraction,
    logins,
    degraded: [...health.degraded, ...extraDegraded],
  };
}

/** How long a FAILED collection is served: short, so a fix shows soon, but
 *  long enough that a polling screen (or many) cannot force a full
 *  collection on every request while something is down. */
export const BOX_STATUS_FAIL_TTL_MS = 5_000;

/** One collection at a time per owner, served for BOX_STATUS_TTL_MS, a
 *  failed one for BOX_STATUS_FAIL_TTL_MS. `collect` and `now` are for tests. */
export function makeBoxStatusCache(
  collect: (ownerId: string) => Promise<BoxStatus>,
  now?: () => number,
): (ownerId: string) => Promise<BoxStatus> {
  const cache = new TtlCache<string, Promise<BoxStatus>>({ ttlMs: BOX_STATUS_TTL_MS, now });
  return (ownerId) => {
    const hit = cache.get(ownerId);
    if (hit) return hit;
    const pending = collect(ownerId);
    cache.set(ownerId, pending);
    pending.catch(() => {
      if (cache.get(ownerId) === pending) cache.set(ownerId, pending, BOX_STATUS_FAIL_TTL_MS);
    });
    return pending;
  };
}

export const boxStatus = makeBoxStatusCache(collectBoxStatus);

/** Install the collector into the box status bridge (@mantle/tools). Boot
 *  calls it once; again is a no-op change. */
export function installBoxStatusProvider(): void {
  registerBoxStatusProvider(boxStatus);
}

/** Pure, for tests: the containers part of the Status view, from the
 *  updater's services.json (null when there is none). */
export function containersView(
  file: ServicesFile | null,
): Pick<BoxStatusView, 'containers' | 'containersCheckedAt' | 'core'> {
  if (!file) return { containers: null, containersCheckedAt: null, core: null };
  return {
    containers: file.containers ? { ...file.containers } : null,
    containersCheckedAt: file.checkedAt,
    core: file.core,
  };
}

/** GET /api/box-status: the status (held to schema 1, as box_status sends
 *  it) and the containers docker reports. Read-only; the status part is the
 *  same 30-second collection every other caller gets. `deps` is for tests. */
export async function boxStatusView(
  ownerId: string,
  deps: {
    status?: (ownerId: string) => Promise<BoxStatus>;
    file?: () => ServicesFile | null;
  } = {},
): Promise<BoxStatusView> {
  const box = shapeBoxStatus(await (deps.status ?? boxStatus)(ownerId));
  if (!box) throw new Error('box status: the collector returned no schema 1 status');
  const c = containersView((deps.file ?? readServicesFile)());
  return {
    box,
    containers: c.containers,
    containersCheckedAt: c.containersCheckedAt,
    core: c.core,
  };
}

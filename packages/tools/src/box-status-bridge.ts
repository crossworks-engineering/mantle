/**
 * Box status bridge. `box_status` (and peer_status's own line) report this
 * box's numbers, and the collectors live in server/web (lib/box-status.ts:
 * the dashboard's system health, the spend, the extractor's queue), not in
 * this package. Same shape as canvas-render-bridge.ts: server/web installs
 * the provider at boot; a process that never installs one (the runner, the
 * stdio MCP server, a worker) gets a clear refusal instead of a crash.
 *
 * Numbers only, whoever reads it: the boxes belong to clients, so nothing
 * here names an item, a person, a host or anything a user wrote.
 * `shapeBoxStatus` holds any status to schema 1's shape, ours before it
 * leaves and a peer's when it arrives.
 */
import type { BoxStatus } from '@mantle/client-types';
import { LOGIN_ROLES } from '@mantle/client-types/role-names';

/** The status itself (schema 1) is a wire shape: @mantle/client-types
 *  dto/box-status, where the Status screen's route (GET /api/box-status)
 *  reads it too. */
export type { BoxStatus };

export type BoxStatusProvider = (ownerId: string) => Promise<BoxStatus>;

let provider: BoxStatusProvider | null = null;

export function registerBoxStatusProvider(fn: BoxStatusProvider | null): void {
  provider = fn;
}

export function getBoxStatusProvider(): BoxStatusProvider | null {
  return provider;
}

/** The refusal a process without the collectors gives. */
export const BOX_STATUS_UNAVAILABLE =
  "No status here: this box's numbers are collected by its web process. Call box_status over the box's MCP endpoint (/api/mcp) or from the app.";

/** The probe names `degraded` may carry: our code's fixed names
 *  (server/web lib/system-health.ts and lib/box-status.ts), and nothing
 *  else. A name a status gives that is not here is dropped. */
export const BOX_STATUS_PROBES: ReadonlySet<string> = new Set([
  'host.cpu',
  'host.mem',
  'host.disk',
  'host.proc',
  'postgres',
  'storage.attachments',
  'storage.objectstore',
  'parser',
  'browser',
  'documents',
  'embedder',
  'network',
  'sandboxes',
  'spend',
  'capacity',
  'extraction',
  'logins',
]);

/** A UTC ISO timestamp, as the collector writes `ts`. */
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** A release version: x.y.z, with an optional alpha, beta or rc tag and
 *  its number (nothing else: a free pre-release tag could carry words). */
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(-(alpha|beta|rc)(\.\d{1,3})?)?$/;
/** A git sha, short or full. */
const GIT_SHA = /^[0-9a-f]{7,40}$/;
/** A build time: an ISO date, with a time and a zone or not. */
const BUILD_TIME =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const num0 = (v: unknown): number => num(v) ?? 0;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const match = (v: unknown, re: RegExp): string | null =>
  typeof v === 'string' && re.test(v) ? v : null;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;
/** The named numeric fields of an object, or null when it is not one. */
function nums<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null {
  const o = obj(v);
  if (!o) return null;
  return Object.fromEntries(keys.map((k) => [k, num0(o[k])])) as Record<K, number>;
}

/**
 * A status rebuilt from schema 1's shape (BoxStatus), or null when it is not
 * one (no object, or `schema` is not 1). Only the known key paths are read;
 * a numeric path keeps a finite number, a flag a boolean, and a string path
 * only a value its own strict pattern or enum admits (`ts`, the build's
 * version, sha and time, `host.scope`, `capacity.zone`); `degraded` keeps
 * only the names in BOX_STATUS_PROBES. Every other key, and every value
 * that does not fit, is dropped (a missing number reads 0 where the shape
 * has no null, null where it does). Pure. Run on our own status before it
 * leaves (box_status) and on every peer's reply (peer_status), so what a
 * linked box sends can carry no text of its own into a model's context.
 */
export function shapeBoxStatus(value: unknown): BoxStatus | null {
  const v = obj(value);
  if (!v || v.schema !== 1) return null;
  const build = obj(v.build) ?? {};
  const proc = obj(v.process) ?? {};
  const host = obj(v.host) ?? {};
  const pg = obj(v.postgres) ?? {};
  const svc = obj(v.services) ?? {};
  const parser = obj(svc.parser) ?? {};
  const cap = obj(v.capacity);
  const zone = cap ? oneOf(cap.zone, ['green', 'watch', 'split'] as const) : null;
  const load = Array.isArray(host.loadAvg) ? host.loadAvg : [];
  const degraded = Array.isArray(v.degraded) ? v.degraded : [];
  return {
    schema: 1,
    ts: match(v.ts, ISO_TS) ?? '',
    build: {
      version: match(build.version, VERSION) ?? '',
      gitSha: match(build.gitSha, GIT_SHA),
      buildTime: match(build.buildTime, BUILD_TIME),
    },
    process: nums(proc, ['uptimeSec', 'heapUsedBytes', 'rssBytes'] as const)!,
    host: {
      scope: oneOf(host.scope, ['container', 'host'] as const) ?? 'container',
      cpuLoadPct: num(host.cpuLoadPct),
      loadAvg: [num0(load[0]), num0(load[1]), num0(load[2])],
      cores: num0(host.cores),
      mem: nums(host.mem, ['usedBytes', 'totalBytes', 'usedPct'] as const),
      disk: nums(host.disk, ['usedBytes', 'totalBytes', 'freeBytes', 'usedPct'] as const),
    },
    postgres: {
      up: bool(pg.up) ?? false,
      dbSizeBytes: num(pg.dbSizeBytes),
      connections: num(pg.connections),
      cacheHitPct: num(pg.cacheHitPct),
    },
    services: {
      objectStore: bool(svc.objectStore),
      parser: {
        up: bool(parser.up) ?? false,
        running: num(parser.running),
        queued: num(parser.queued),
      },
      browser: bool(svc.browser),
      documents: bool(svc.documents),
      embedder: bool(svc.embedder),
      sandboxes: bool(svc.sandboxes),
      network: bool(svc.network),
    },
    spend: nums(v.spend, [
      'last24hMicroUsd',
      'last7dMicroUsd',
      'last30dMicroUsd',
      'traces24h',
      'turns24h',
      'errors24h',
    ] as const),
    capacity:
      cap && zone
        ? {
            docs: num0(cap.docs),
            chunkVectors: num0(cap.chunkVectors),
            zone,
            pctOfSplit: num0(cap.pctOfSplit),
          }
        : null,
    extraction: nums(v.extraction, [
      'running',
      'waiting',
      'retrying',
      'doneLast10Min',
      'deadLettered',
    ] as const),
    logins: nums(v.logins, [...LOGIN_ROLES, 'disabled', 'total'] as const),
    degraded: [
      ...new Set(
        degraded.filter((d): d is string => typeof d === 'string' && BOX_STATUS_PROBES.has(d)),
      ),
    ],
  };
}

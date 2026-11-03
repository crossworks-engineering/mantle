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
 * `numbersOnly` holds any status to that, ours before it leaves and a
 * peer's when it arrives.
 */

/** A probe that did not answer in time names itself in `degraded` (our code's
 *  fixed names, e.g. `host.cpu`, `postgres`). */
export type BoxStatus = {
  schema: 1;
  /** When it was collected (ISO). */
  ts: string;
  build: { version: string; gitSha: string | null; buildTime: string | null };
  process: { uptimeSec: number; heapUsedBytes: number; rssBytes: number };
  host: {
    /** `container`: the web container's own view; `host`: the host's /proc
     *  (MANTLE_HOST_PROC). */
    scope: 'container' | 'host';
    cpuLoadPct: number | null;
    loadAvg: [number, number, number];
    cores: number;
    mem: { usedBytes: number; totalBytes: number; usedPct: number } | null;
    disk: { usedBytes: number; totalBytes: number; freeBytes: number; usedPct: number } | null;
  };
  postgres: {
    up: boolean;
    dbSizeBytes: number | null;
    connections: number | null;
    cacheHitPct: number | null;
  };
  /** Up (true), down (false), or switched off or not known (null). */
  services: {
    objectStore: boolean | null;
    parser: { up: boolean; running: number | null; queued: number | null };
    browser: boolean | null;
    documents: boolean | null;
    embedder: boolean | null;
    sandboxes: boolean | null;
    network: boolean | null;
  };
  /** Model spend in micro-USD over rolling windows, and the traces of the
   *  last 24 hours: all of them, the assistant turns, the failed. */
  spend: {
    last24hMicroUsd: number;
    last7dMicroUsd: number;
    last30dMicroUsd: number;
    traces24h: number;
    turns24h: number;
    errors24h: number;
  } | null;
  /** The corpus against the split policy (@mantle/content corpusCapacity). */
  capacity: {
    docs: number;
    chunkVectors: number;
    zone: 'green' | 'watch' | 'split';
    pctOfSplit: number;
  } | null;
  extraction: {
    running: number;
    waiting: number;
    retrying: number;
    doneLast10Min: number;
    deadLettered: number;
  } | null;
  /** Logins by display role (enabled), and the disabled ones. */
  logins: { admin: number; member: number; disabled: number; total: number } | null;
  degraded: string[];
};

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

/** A string a status may carry: a version, a sha, a timestamp, a zone, a
 *  probe's name. Never a space, so never a sentence. */
const SAFE_STRING = /^[A-Za-z0-9_.:+-]{0,64}$/;
/** A key a status may carry. */
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 64;

/**
 * A status held to numbers: finite numbers, booleans and null pass; a string
 * only when it is one word of the safe characters (a version, a timestamp, a
 * probe's name); objects and arrays to a bounded depth and size, under safe
 * keys. Anything else becomes null (a key that is not safe is dropped).
 * Pure. Run on our own status before it leaves (so a later field that
 * slipped in a name still could not), and on every peer's reply
 * (peer_status), so what a linked box sends cannot carry text into a
 * model's context.
 */
export function numbersOnly(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : null;
  if (depth >= MAX_DEPTH || typeof value !== 'object') return null;
  if (Array.isArray(value))
    return value.slice(0, MAX_ENTRIES).map((v) => numbersOnly(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
    if (SAFE_KEY.test(k)) out[k] = numbersOnly(v, depth + 1);
  }
  return out;
}

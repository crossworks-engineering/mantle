/**
 * This box's status as numbers (schema 1): what the box_status tool returns
 * (@mantle/tools box-status-bridge.ts, collected by server/web
 * lib/box-status.ts) and what GET /api/box-status serves the Status screen,
 * beside the containers docker reports. Numbers, booleans and fixed words
 * only: the boxes belong to clients, so nothing here names an item, a
 * person, a host or anything a user wrote.
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

/** One long-running container as the updater sidecar saw it (`docker
 *  inspect`, every ~5 minutes and after a roll or a switch). */
export type BoxContainerState = {
  /** docker's State.Status: 'running', 'restarting', 'exited', 'created',
   *  'paused', 'removing', 'dead'; 'absent' when the box does not run it;
   *  'unknown' when the updater's file said anything else. */
  container: string;
  /** The healthcheck: 'healthy', 'unhealthy', 'starting', 'none', or
   *  'unknown'. */
  health: string;
  /** docker's restart count: restarts by its own restart policy only. It
   *  does NOT count autoheal's (`docker restart`), so a worker autoheal
   *  keeps restarting can read 0 here; `startedAt` is the signal for those
   *  (a long-running container that started recently, well after the rest
   *  of the stack). */
  restarts: number;
  /** When it last started (ISO, to the second), or null. */
  startedAt: string | null;
};

/**
 * GET /api/box-status (settings area, read-only): the box status, and every
 * long-running container of the stack by its compose service name
 * (`postgres`, `objectstore`, `gotenberg`, `worker_email`, `client_web`,
 * ...: @mantle/config BOX_CONTAINERS). `containers` is null where the brain
 * cannot read the updater's services.json (no updater, an updater before the
 * field, a dev process).
 */
export type BoxStatusView = {
  box: BoxStatus;
  containers: Record<string, BoxContainerState> | null;
  /** When the updater last wrote them (ISO), or null. */
  containersCheckedAt: string | null;
  /** The 4 GB core shape (docker-compose.core.yml): some workers and the
   *  browser run only with a profile there. Null when not known. */
  core: boolean | null;
};

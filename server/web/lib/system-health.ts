import os from 'node:os';
import { statfs } from 'node:fs/promises';
import si from 'systeminformation';
import { db, sql } from '@mantle/db';
import { filesRoot, mediaSidecarHealth, tikaVersion } from '@mantle/files';
import { sandboxdHealth } from './sandboxd';
import { bucketReachable } from '@mantle/storage';
import { resolveEmbeddingConfig, probeEmbeddingRoute } from '@mantle/embeddings';
import { attachmentBytes } from './dashboard';
import { getTailnetStatus } from './tailscale';
import { browserHealth } from './render-pdf';
import type { SystemHealth } from '@mantle/client-types';
import type { DiskInfo } from '@mantle/client-types';
export type { DiskInfo };
export type { SystemHealth };

/**
 * Live system/infra vitals for the dashboard. Server-only — imported ONLY by
 * the /api/health route handler (never by the server page or a client bundle,
 * because `systeminformation` shells out and must stay off the hot render path).
 *
 * Every probe is wrapped in a timeout + allSettled so a slow host call can't
 * hang the endpoint; a failed/timed-out probe yields null and its dotted path
 * is appended to `degraded`. In a prod container CPU/RAM/disk reflect the
 * container's cgroup, not the VPS host — surfaced via `scope`.
 */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

type PgStatsRow = { db_size: string; connections: number; cache_hit: number | null };
type PgTableRow = { name: string; bytes: string };

async function pgHealth() {
  const statsResult = await db.execute<PgStatsRow>(sql`
    SELECT
      pg_database_size(current_database()) AS db_size,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
      (SELECT CASE WHEN sum(blks_hit) + sum(blks_read) = 0 THEN NULL
                   ELSE sum(blks_hit)::float8 / (sum(blks_hit) + sum(blks_read)) END
       FROM pg_stat_database WHERE datname = current_database()) AS cache_hit
  `);
  const tablesResult = await db.execute<PgTableRow>(sql`
    SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 6
  `);
  const stats = (
    Array.isArray(statsResult) ? statsResult : ((statsResult as { rows?: PgStatsRow[] }).rows ?? [])
  )[0];
  const tables = (
    Array.isArray(tablesResult)
      ? tablesResult
      : ((tablesResult as { rows?: PgTableRow[] }).rows ?? [])
  ) as PgTableRow[];
  return {
    dbSizeBytes: stats ? Number(stats.db_size) : null,
    connections: stats ? Number(stats.connections) : null,
    cacheHitPct: stats?.cache_hit != null ? Number(stats.cache_hit) * 100 : null,
    topTables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })),
  };
}

const DEFAULT_LOCAL_EMBED_URL = 'http://localhost:11434/v1';

/** Probe the configured embedder. Only the `local` provider is a self-hosted
 *  server we can ping (Ollama/LM Studio/TEI on the per-route base URL or
 *  MANTLE_LOCAL_EMBEDDING_URL); we GET its OpenAI-compatible `/models` and
 *  confirm the configured model is loaded — "reachable AND serving the right
 *  model" is the only state that actually embeds. Cloud providers need a key
 *  and cost a call, so they report as remote (up: null). Never throws.
 *
 *  Resolution goes through `resolveEmbeddingConfig` — the SAME single source of
 *  truth ingest uses — so a fresh install with no `embedding_config` row sees
 *  the bundled local default (LOCAL_FALLBACK_CONFIG) and gets probed, instead
 *  of being reported "not configured" while it is in fact embedding. */
/** Remote (cloud) embedders are verified with a REAL 1-token embed through the
 *  configured route (provider + model + stored key) — the same call the
 *  /settings/embedding "test" button makes. That costs a (tiny) paid API call,
 *  and the dashboard polls every 10s, so results are cached: 5 min while
 *  healthy, 60s after a failure (recovery shows within a minute). */
const REMOTE_EMBED_OK_TTL_MS = 5 * 60_000;
const REMOTE_EMBED_FAIL_TTL_MS = 60_000;
const remoteEmbedCache = new Map<string, { at: number; up: boolean; detail: string }>();

async function embedderHealth(userId: string): Promise<SystemHealth['embedder']> {
  const cfg = await resolveEmbeddingConfig(userId);
  const provider = cfg.primary.provider;
  const model = cfg.model;
  if (provider !== 'local') {
    const cached = remoteEmbedCache.get(userId);
    const ttl = cached?.up ? REMOTE_EMBED_OK_TTL_MS : REMOTE_EMBED_FAIL_TTL_MS;
    if (cached && Date.now() - cached.at < ttl) {
      return { up: cached.up, provider, model, detail: cached.detail, scope: 'remote' };
    }
    try {
      const t0 = Date.now();
      await probeEmbeddingRoute(userId, {
        provider,
        model,
        baseUrl: cfg.primary.baseUrl,
        apiKeyId: cfg.primary.apiKeyId,
      });
      const detail = `${provider} · ${model} · ${Date.now() - t0}ms`;
      remoteEmbedCache.set(userId, { at: Date.now(), up: true, detail });
      return { up: true, provider, model, detail, scope: 'remote' };
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : 'probe failed';
      const detail = `${provider} · ${model} · ${msg}`;
      remoteEmbedCache.set(userId, { at: Date.now(), up: false, detail });
      return { up: false, provider, model, detail, scope: 'remote' };
    }
  }
  const base = (
    cfg.primary.baseUrl ||
    process.env.MANTLE_LOCAL_EMBEDDING_URL ||
    DEFAULT_LOCAL_EMBED_URL
  ).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1_200) });
    if (!res.ok)
      return {
        up: false,
        provider,
        model,
        detail: `unreachable · HTTP ${res.status}`,
        scope: 'local',
      };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === 'string');
    // Ollama reports ids like `embeddinggemma:latest`; tolerate the `:latest`
    // suffix on either side so a bare-name config still matches.
    const norm = (s: string) => s.replace(/:latest$/, '');
    const present = ids.some((id) => norm(id) === norm(model));
    return present
      ? { up: true, provider, model, detail: `${model} · loaded`, scope: 'local' }
      : { up: false, provider, model, detail: `${model} not loaded`, scope: 'local' };
  } catch {
    return { up: false, provider, model, detail: 'unreachable', scope: 'local' };
  }
}

/** Probe the tailnet via tailscaled's LocalAPI (shared socket). `up: true` only
 *  when connected (backendState 'Running'); anything else — socket absent
 *  (tailnet profile off, the dev default), NeedsLogin, Stopped — is `up: null`
 *  so the UI shows a muted/disabled pill rather than a red error for an
 *  optional, off-by-default feature. getTailnetStatus never throws. */
async function networkHealth(): Promise<SystemHealth['network']> {
  const r = await getTailnetStatus(1_200);
  if (!r.available) return { up: null, detail: r.reason };
  if (r.backendState !== 'Running') return { up: null, detail: `tailscaled ${r.backendState}` };
  const online = r.peers.filter((p) => p.online).length;
  const who = r.self?.hostName || r.self?.dnsName || 'this node';
  const suffix = r.magicDNSSuffix ? ` · ${r.magicDNSSuffix}` : '';
  return { up: true, detail: `${who}${suffix} · ${online}/${r.peers.length} peers online` };
}

/** Disk usage of the volume holding MANTLE_FILES_ROOT, via systeminformation's
 *  per-mount list (best mount-prefix match), falling back to fs.statfs. */
async function filesDisk(): Promise<DiskInfo> {
  const root = filesRoot();
  try {
    const list = await si.fsSize();
    const matches = list
      .filter((d) => d.mount && root.startsWith(d.mount))
      .sort((a, b) => b.mount.length - a.mount.length);
    const d = matches[0] ?? list.find((x) => x.mount === '/') ?? list[0];
    if (d && d.size > 0) {
      return {
        usedBytes: d.used,
        totalBytes: d.size,
        usedPct: typeof d.use === 'number' ? d.use : (d.used / d.size) * 100,
        mount: d.mount,
      };
    }
  } catch {
    /* fall through to statfs */
  }
  const st = await statfs(root);
  const totalBytes = Number(st.blocks) * st.bsize;
  const availBytes = Number(st.bavail) * st.bsize;
  const usedBytes = totalBytes - availBytes;
  return {
    usedBytes,
    totalBytes,
    usedPct: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
    mount: root,
  };
}

export async function getSystemHealth(userId: string): Promise<SystemHealth> {
  const degraded: string[] = [];
  async function probe<T>(name: string, fn: () => Promise<T>, ms = 1800): Promise<T | null> {
    try {
      return await withTimeout(fn(), ms);
    } catch {
      degraded.push(name);
      return null;
    }
  }

  const [load, mem, disk, pg, attBytes, minioUp, tikaVer, browserH, emb, net, sbx, media] =
    await Promise.all([
      probe('host.cpu', () => si.currentLoad()),
      probe('host.mem', () => si.mem()),
      probe('host.disk', () => filesDisk()),
      probe('postgres', () => pgHealth()),
      probe('storage.attachments', () => attachmentBytes(userId)),
      probe('storage.minio', () => bucketReachable()),
      // tikaVersion is itself never-throws (returns null on any failure),
      // so the probe wrapper is mostly belt-and-braces here — the timeout
      // still applies if the wrapper hangs longer than expected.
      probe('tika', () => tikaVersion(1_500)),
      // browserHealth (PDF sidecar) is likewise never-throws; wrapper bounds it.
      probe('browser', () => browserHealth(1_500)),
      // embedderHealth is likewise never-throws; the wrapper just bounds it. A
      // cold remote probe is a real API round-trip, so it gets a longer leash
      // (cached 5 min after — see remoteEmbedCache).
      probe('embedder', () => embedderHealth(userId), 6_000),
      // networkHealth (tailnet) also never-throws; the wrapper just bounds it.
      probe('network', () => networkHealth()),
      // sandboxdHealth never-throws (profile off ⇒ up:null; unreachable ⇒
      // up:false); the wrapper bounds a hung listing.
      probe('sandboxes', () => sandboxdHealth()),
      // mediaSidecarHealth never-throws (profile off ⇒ up:null; unreachable ⇒
      // up:false); its versions expose a stale/failed yt-dlp self-update.
      probe('media', () => mediaSidecarHealth(1_500)),
    ]);

  const memInfo = mem
    ? {
        usedBytes: mem.total - mem.available,
        totalBytes: mem.total,
        usedPct: mem.total ? ((mem.total - mem.available) / mem.total) * 100 : 0,
      }
    : null;

  return {
    ts: new Date().toISOString(),
    scope: process.env.NODE_ENV === 'production' ? 'container' : 'host',
    host: {
      cpuLoadPct: load ? load.currentLoad : null,
      mem: memInfo,
      disk,
      uptimeSec: process.uptime(),
      heapUsedBytes: process.memoryUsage().heapUsed,
      rssBytes: process.memoryUsage().rss,
      loadAvg: os.loadavg(),
      cpuCores: os.cpus().length,
    },
    postgres: {
      up: pg != null,
      dbSizeBytes: pg?.dbSizeBytes ?? null,
      connections: pg?.connections ?? null,
      cacheHitPct: pg?.cacheHitPct ?? null,
      topTables: pg?.topTables ?? [],
    },
    storage: {
      minioUp: minioUp,
      attachmentBytes: attBytes,
      filesDisk: disk,
    },
    tika: {
      // tikaVersion returns null on down/timeout/non-2xx/empty; the probe
      // wrapper also returns null on its own timeout. Either way, no version
      // string ⇒ Tika is unreachable from the web process's point of view.
      up: typeof tikaVer === 'string' && tikaVer.length > 0,
      version: typeof tikaVer === 'string' ? tikaVer : null,
    },
    // probe() returns null on its own timeout — treat that as sidecar-down
    // (BROWSER_WS_ENDPOINT unset is reported by browserHealth itself as up:null).
    browser: browserH ?? { up: false, version: null },
    embedder: emb ?? { up: null, provider: null, model: null, detail: null, scope: null },
    sandboxes: sbx ?? { up: null, total: null, running: null, disk: null },
    media: media ?? { up: null, ytDlpVersion: null, ffmpegVersion: null, ezdwfVersion: null },
    network: net ?? { up: null, detail: null },
    degraded,
  };
}

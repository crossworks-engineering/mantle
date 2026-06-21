import os from 'node:os';
import { statfs } from 'node:fs/promises';
import si from 'systeminformation';
import { db, sql } from '@mantle/db';
import { filesRoot, tikaVersion } from '@mantle/files';
import { bucketReachable } from '@mantle/storage';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { attachmentBytes } from './dashboard';
import { getTailnetStatus } from './tailscale';

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

export type DiskInfo = { usedBytes: number; totalBytes: number; usedPct: number; mount: string };

export type SystemHealth = {
  ts: string;
  scope: 'container' | 'host';
  host: {
    cpuLoadPct: number | null;
    mem: { usedBytes: number; totalBytes: number; usedPct: number } | null;
    disk: DiskInfo | null;
    uptimeSec: number;
    heapUsedBytes: number;
    rssBytes: number;
    loadAvg: number[];
    cpuCores: number;
  };
  postgres: {
    up: boolean;
    dbSizeBytes: number | null;
    connections: number | null;
    cacheHitPct: number | null;
    topTables: { name: string; bytes: number }[];
  };
  storage: {
    minioUp: boolean | null;
    attachmentBytes: number | null;
    filesDisk: DiskInfo | null;
  };
  /** Tier-2 document parser fallback (.odt / .pptx / .doc / .rtf / .epub /
   *  …) — sibling docker service. `up: false` means the fallback path
   *  degrades cleanly to `no_text_layer` on every new ingest of those
   *  formats; in-process parsers (pdf/docx/xlsx/text) keep working. */
  tika: {
    up: boolean;
    version: string | null;
  };
  /** The configured embedding server. For the `local` provider this is the
   *  self-hosted Ollama/LM Studio/TEI on MANTLE_LOCAL_EMBEDDING_URL (the
   *  bundled `ollama` compose service in prod). `up: true` means it's
   *  reachable AND the configured model is loaded — the only state in which
   *  ingest can actually embed. `up: null` = a remote/cloud embedder
   *  (openrouter/openai/google), which isn't pingable from here without a key,
   *  so it's surfaced as "remote" rather than a misleading red dot. */
  embedder: {
    up: boolean | null;
    provider: string | null;
    model: string | null;
    detail: string | null;
  };
  /** Tailscale / local network — the optional tailnet that lets a cloud VPS
   *  reach a LAN model box by MagicDNS name. Profile-gated and off by default
   *  in dev, so `up: null` (a muted/disabled pill) is the normal resting state;
   *  `up: true` only when tailscaled reports backendState 'Running'. */
  network: {
    up: boolean | null;
    detail: string | null;
  };
  degraded: string[];
};

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
  const stats = (Array.isArray(statsResult) ? statsResult : (statsResult as { rows?: PgStatsRow[] }).rows ?? [])[0];
  const tables = (Array.isArray(tablesResult) ? tablesResult : (tablesResult as { rows?: PgTableRow[] }).rows ?? []) as PgTableRow[];
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
async function embedderHealth(userId: string): Promise<SystemHealth['embedder']> {
  const cfg = await resolveEmbeddingConfig(userId);
  const provider = cfg.primary.provider;
  const model = cfg.model;
  if (provider !== 'local') {
    return { up: null, provider, model, detail: `remote · ${provider}` };
  }
  const base = (cfg.primary.baseUrl || process.env.MANTLE_LOCAL_EMBEDDING_URL || DEFAULT_LOCAL_EMBED_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1_200) });
    if (!res.ok) return { up: false, provider, model, detail: `unreachable · HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    // Ollama reports ids like `embeddinggemma:latest`; tolerate the `:latest`
    // suffix on either side so a bare-name config still matches.
    const norm = (s: string) => s.replace(/:latest$/, '');
    const present = ids.some((id) => norm(id) === norm(model));
    return present
      ? { up: true, provider, model, detail: `${model} · loaded` }
      : { up: false, provider, model, detail: `${model} not loaded` };
  } catch {
    return { up: false, provider, model, detail: 'unreachable' };
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

  const [load, mem, disk, pg, attBytes, minioUp, tikaVer, emb, net] = await Promise.all([
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
    // embedderHealth is likewise never-throws; the wrapper just bounds it.
    probe('embedder', () => embedderHealth(userId)),
    // networkHealth (tailnet) also never-throws; the wrapper just bounds it.
    probe('network', () => networkHealth()),
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
    embedder: emb ?? { up: null, provider: null, model: null, detail: null },
    network: net ?? { up: null, detail: null },
    degraded,
  };
}

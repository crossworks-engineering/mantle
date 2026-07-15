import { promises as fs } from 'node:fs';
import path from 'node:path';

import { db, sql } from '@mantle/db';
import { bucketStatus } from '@mantle/storage';
import { filesRoot } from '@mantle/files';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { runTableStorageProbes } from '@mantle/tabledb';

import { readUpdaterStatus, updaterAvailable } from '../updates';
import type { SanityCheck, SanityReport } from './types';

/**
 * System sanity checks — the CONFIG-correctness counterpart to lib/system-health
 * (which is liveness). Each check probes one thing that can be silently broken
 * by a missing env var or a provisioning step only `scripts/up.sh` runs, and
 * returns a status + a remediation. Every check is wrapped so a probe can never
 * throw the whole report; a thrown probe degrades to a `warn` "couldn't verify".
 *
 * Read-only: no check mutates infra. See ./types for the why.
 */

const SIGNAL_DIR = process.env.MANTLE_UPDATE_SIGNAL_DIR ?? '/signal';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function checkBucket(): Promise<SanityCheck> {
  const base = { key: 'storage.bucket', label: 'Object-store bucket', category: 'Storage' as const };
  const s = await bucketStatus();
  if (!s.reachable) {
    return {
      ...base,
      status: 'warn',
      detail: `Couldn't reach the object store to verify bucket “${s.bucket}”. Check S3_ENDPOINT / that MinIO is up (the health pills cover liveness).`,
      fix: null,
    };
  }
  if (s.exists === false) {
    return {
      ...base,
      status: 'fail',
      detail: `MinIO is up but the “${s.bucket}” bucket does not exist — every app build and file upload fails with “The specified bucket does not exist”. Only scripts/up.sh creates it; a registry-pull box that never ran it has no bucket.`,
      fix: {
        summary: `Create the bucket in MinIO (one-shot, matches what up.sh does), then app builds / uploads work immediately.`,
        command: `docker exec mantle_minio sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb -p local/${s.bucket} && mc anonymous set none local/${s.bucket}'`,
      },
    };
  }
  if (s.exists === null) {
    return {
      ...base,
      status: 'warn',
      detail: `Object store answered but the credentials lack HeadBucket permission, so bucket “${s.bucket}” existence can't be confirmed from here.`,
      fix: null,
    };
  }
  return { ...base, status: 'pass', detail: `Bucket “${s.bucket}” exists and is reachable.`, fix: null };
}

// ── Updater ──────────────────────────────────────────────────────────────────

async function checkUpdater(): Promise<SanityCheck> {
  const base = { key: 'updater.configured', label: 'In-app updater', category: 'Updater' as const };
  const available = await updaterAvailable();
  if (!available) {
    // No signal volume mounted → this deployment has no updater sidecar (dev, or
    // a stack without it). Not a fault — just not applicable.
    return {
      ...base,
      status: 'na',
      detail: `No updater sidecar on this deployment (signal volume ${SIGNAL_DIR} not mounted). Updates are applied another way here.`,
      fix: null,
    };
  }
  const status = await readUpdaterStatus();
  if (status?.phase === 'unconfigured') {
    return {
      ...base,
      status: 'fail',
      detail: `The updater sidecar is running but unconfigured${status.error ? ` — ${status.error}` : ''}. MANTLE_STACK_DIR is unset (or no docker-compose.yml at that path), so every in-app update silently parks and never applies.`,
      fix: {
        summary: `Set MANTLE_STACK_DIR to the HOST-absolute path of the deploy bundle (the dir holding docker-compose.yml) in the host .env, then recreate the updater container.`,
        command: `# in the deploy bundle's .env, e.g.:\nMANTLE_STACK_DIR=/home/cwe/mantle\n# then: docker compose up -d --force-recreate updater`,
      },
    };
  }
  if (status?.phase === 'error') {
    return {
      ...base,
      status: 'warn',
      detail: `Updater is configured but its last run errored${status.error ? ` — ${status.error}` : ''}. Updates may still work; check the updater log.`,
      fix: null,
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `Updater sidecar is configured and reachable (phase: ${status?.phase ?? 'idle'}).`,
    fix: null,
  };
}

// ── Environment ──────────────────────────────────────────────────────────────

function checkSecrets(): SanityCheck {
  const base = { key: 'env.secrets', label: 'Required secrets', category: 'Environment' as const };
  const missing: string[] = [];
  const masterKey = process.env.MANTLE_MASTER_KEY ?? '';
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (!masterKey) missing.push('MANTLE_MASTER_KEY');
  if (!sessionSecret) missing.push('SESSION_SECRET');
  if (missing.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: `Missing: ${missing.join(', ')}. Without these, stored secrets can't be decrypted and sessions won't verify.`,
      fix: {
        summary: `Set the missing keys in the host .env and recreate the stack. MANTLE_MASTER_KEY must be base64 of 32 random bytes; SESSION_SECRET ≥ 32 chars.`,
        command: `openssl rand -base64 32   # MANTLE_MASTER_KEY\nopenssl rand -hex 32      # SESSION_SECRET`,
      },
    };
  }
  // Present but malformed master key is a silent decrypt-failure waiting to happen.
  let masterBytes = 0;
  try {
    masterBytes = Buffer.from(masterKey, 'base64').length;
  } catch {
    masterBytes = 0;
  }
  if (masterBytes !== 32) {
    return {
      ...base,
      status: 'warn',
      detail: `MANTLE_MASTER_KEY is set but decodes to ${masterBytes} bytes, not 32 — AES-256 needs exactly 32. Secret decryption may fail.`,
      fix: { summary: `Regenerate as base64 of 32 bytes.`, command: `openssl rand -base64 32` },
    };
  }
  return { ...base, status: 'pass', detail: `MANTLE_MASTER_KEY (32 bytes) and SESSION_SECRET are set.`, fix: null };
}

async function checkFilesRoot(): Promise<SanityCheck> {
  const base = { key: 'env.files_root', label: 'Files root', category: 'Environment' as const };
  const root = filesRoot();
  if (!path.isAbsolute(root)) {
    return {
      ...base,
      status: 'warn',
      detail: `MANTLE_FILES_ROOT is unset, so files resolve to a cwd-relative path (“${root}”). Each process can see a different root → uploaded files appear missing across web/workers.`,
      fix: {
        summary: `Set MANTLE_FILES_ROOT to an absolute, bind-mounted path shared by every service.`,
        command: `MANTLE_FILES_ROOT=/data/files`,
      },
    };
  }
  try {
    await fs.access(root, fs.constants.W_OK);
  } catch {
    return {
      ...base,
      status: 'fail',
      detail: `Files root “${root}” is not writable by this process — uploads and extraction will fail.`,
      fix: { summary: `Ensure the path exists and is writable by the container user (check the bind-mount ownership).` },
    };
  }
  return { ...base, status: 'pass', detail: `Files root “${root}” is absolute and writable.`, fix: null };
}

function checkPublicUrl(): SanityCheck {
  const base = { key: 'env.public_url', label: 'Public URL', category: 'Environment' as const };
  const url = process.env.MANTLE_PUBLIC_URL ?? '';
  const isLocal = !url || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);
  if (isLocal) {
    return {
      ...base,
      status: 'warn',
      detail: url
        ? `MANTLE_PUBLIC_URL is “${url}” — share links and outbound emails will embed a localhost address that recipients can't open.`
        : `MANTLE_PUBLIC_URL is unset — absolute links in shares and emails fall back to localhost. Fine on a dev box; broken on a deployed one.`,
      fix: {
        summary: `Set MANTLE_PUBLIC_URL to the box's public HTTPS origin so share/email links resolve.`,
        command: `MANTLE_PUBLIC_URL=https://brain.example.com`,
      },
    };
  }
  return { ...base, status: 'pass', detail: `Public URL is “${url}”.`, fix: null };
}

// ── Embedding ────────────────────────────────────────────────────────────────

const DEFAULT_LOCAL_EMBED_URL = 'http://localhost:11434/v1';

async function checkEmbedder(userId: string): Promise<SanityCheck> {
  const base = { key: 'embedding.model', label: 'Embedding model', category: 'Embedding' as const };
  const cfg = await resolveEmbeddingConfig(userId);
  const provider = cfg.primary.provider;
  const model = cfg.model;
  if (provider !== 'local') {
    return {
      ...base,
      status: 'na',
      detail: `Remote embedder (${provider}) — can't be probed without a key/cost. Configured model: ${model}.`,
      fix: null,
    };
  }
  const baseUrl = (cfg.primary.baseUrl || process.env.MANTLE_LOCAL_EMBEDDING_URL || DEFAULT_LOCAL_EMBED_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) {
      return {
        ...base,
        status: 'fail',
        detail: `Local embedder at ${baseUrl} answered HTTP ${res.status}. Ingest can't embed → search/recall silently degrade.`,
        fix: { summary: `Check the bundled ollama service is up and MANTLE_LOCAL_EMBEDDING_URL points at it.` },
      };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    const norm = (s: string) => s.replace(/:latest$/, '');
    const present = ids.some((id) => norm(id) === norm(model));
    if (!present) {
      return {
        ...base,
        status: 'fail',
        detail: `Local embedder is up but model “${model}” is not loaded — every embed fails silently (the model pull, an up.sh/compose one-shot, didn't run).`,
        fix: {
          summary: `Pull the model into the embedder.`,
          command: `docker exec mantle_ollama ollama pull ${model}`,
        },
      };
    }
    return { ...base, status: 'pass', detail: `Local embedder serving “${model}”.`, fix: null };
  } catch {
    return {
      ...base,
      status: 'fail',
      detail: `Local embedder at ${baseUrl} is unreachable — ingest can't embed.`,
      fix: { summary: `Check the bundled ollama service is up and MANTLE_LOCAL_EMBEDDING_URL points at it.` },
    };
  }
}

// ── Database ─────────────────────────────────────────────────────────────────

type SchemaRow = { present: boolean };

async function checkPgBoss(): Promise<SanityCheck> {
  const base = { key: 'db.pgboss', label: 'Background-job schema', category: 'Database' as const };
  const result = await db.execute<SchemaRow>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'
    ) AS present
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: SchemaRow[] }).rows ?? []) as SchemaRow[];
  const present = rows[0]?.present === true;
  if (!present) {
    return {
      ...base,
      status: 'fail',
      detail: `The “pgboss” schema is missing — background jobs (email, extraction, ingest) crash on startup. Created by the migrate one-shot / up.sh's pgboss:init.`,
      fix: {
        summary: `Run the migrate/provision step for this stack.`,
        command: `docker compose run --rm migrate   # (prod compose)  ·  or: pnpm -C apps/web pgboss:init`,
      },
    };
  }
  return { ...base, status: 'pass', detail: `Background-job schema “pgboss” is present.`, fix: null };
}

// ── Table storage ────────────────────────────────────────────────────────────

async function checkTableStorageDir(): Promise<SanityCheck> {
  const base = { key: 'tables.storage', label: 'Table-storage volume', category: 'Storage' as const };
  const { tableDbRoot, resolveStoragePath } = await import('@mantle/tabledb');
  const { db: dbc, sql: sqlc } = await import('@mantle/db');
  const root = tableDbRoot();

  if (!process.env.TABLE_DB_DIR) {
    return {
      ...base,
      status: 'warn',
      detail: `TABLE_DB_DIR is unset, so table workbooks resolve to a cwd-relative path (“${root}”). Fine in dev; on a deployed box each process could see a different root.`,
      fix: {
        summary: `Set TABLE_DB_DIR to the shared bind mount in the compose env (web AND api).`,
        command: `TABLE_DB_DIR=/data/table-dbs`,
      },
    };
  }
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.access(root, fs.constants.W_OK);
  } catch {
    return {
      ...base,
      status: 'fail',
      detail: `Table-storage root “${root}” is not writable by this process — every table create/edit fails. Check the ${'${MANTLE_DATA_DIR}'}/table-dbs bind mount (a tag-only update misses compose changes — refresh the deploy bundle).`,
      fix: { summary: `Ensure the table-dbs mount exists in docker-compose.yml for BOTH web and api and is writable by the container user.` },
    };
  }

  // Registry ↔ file consistency, newest rows first: a row with storage_path
  // whose file is gone is data loss the moment someone opens that table —
  // say so BEFORE they do.
  type Row = { node_id: string; storage_path: string };
  const result = await dbc.execute<Row>(sqlc`
    SELECT node_id, storage_path FROM tables
    WHERE storage_path IS NOT NULL ORDER BY updated_at DESC LIMIT 50
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: Row[] }).rows ?? []) as Row[];
  const missing: string[] = [];
  for (const r of rows) {
    try {
      await fs.access(resolveStoragePath(r.storage_path));
    } catch {
      missing.push(r.node_id);
    }
  }
  if (missing.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: `${missing.length} of ${rows.length} sampled file-backed tables have NO workbook file on disk (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). Those tables will error on open — restore the files from a backup (mantle-table-dbs-*).`,
      fix: { summary: `Untar the latest mantle-table-dbs-*.tgz back into ${'${MANTLE_DATA_DIR}'}/table-dbs, or restore the per-table snapshot from the in-app backup directory.` },
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `Root “${root}” mounted + writable; ${rows.length} sampled file-backed table(s) all have their workbook on disk.`,
    fix: null,
  };
}

async function checkTableStorageProbes(): Promise<SanityCheck> {
  const base = { key: 'tables.sqlite_probes', label: 'Table-storage engine', category: 'Database' as const };
  const report = await runTableStorageProbes();
  if (!report.ok) {
    const failed = report.results.filter((r) => !r.ok && r.required);
    return {
      ...base,
      status: 'fail',
      detail: `node:sqlite drifted on this image (node ${process.version}) — ${failed
        .map((r) => `${r.key}: ${r.detail}`)
        .join('; ')}. Sqlite-native table storage must not be used until the image is fixed.`,
      fix: {
        summary: `Pin the deployment to the previous image and report the Node/node:sqlite drift — the probes name the exact behavior that broke.`,
      },
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `node:sqlite engine behaviors verified (readOnly enforcement, WAL, FTS5 trigram, MATCH quoting, VACUUM INTO).`,
    fix: null,
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run every sanity check. Each is individually timeout-guarded and degraded to
 * a `warn` "couldn't verify" rather than failing the whole report — a broken
 * checker must never look like a broken system.
 */
export async function runSanityChecks(userId: string): Promise<SanityReport> {
  const defs: Array<{ key: string; label: string; category: SanityCheck['category']; run: () => Promise<SanityCheck> }> = [
    { key: 'storage.bucket', label: 'Object-store bucket', category: 'Storage', run: checkBucket },
    { key: 'updater.configured', label: 'In-app updater', category: 'Updater', run: checkUpdater },
    { key: 'env.secrets', label: 'Required secrets', category: 'Environment', run: async () => checkSecrets() },
    { key: 'env.files_root', label: 'Files root', category: 'Environment', run: checkFilesRoot },
    { key: 'env.public_url', label: 'Public URL', category: 'Environment', run: async () => checkPublicUrl() },
    { key: 'embedding.model', label: 'Embedding model', category: 'Embedding', run: () => checkEmbedder(userId) },
    { key: 'db.pgboss', label: 'Background-job schema', category: 'Database', run: checkPgBoss },
    { key: 'tables.sqlite_probes', label: 'Table-storage engine', category: 'Database', run: checkTableStorageProbes },
    { key: 'tables.storage', label: 'Table-storage volume', category: 'Storage', run: checkTableStorageDir },
  ];

  const checks = await Promise.all(
    defs.map(async (d): Promise<SanityCheck> => {
      try {
        return await withTimeout(d.run(), 3_000);
      } catch (err) {
        return {
          key: d.key,
          label: d.label,
          category: d.category,
          status: 'warn',
          detail: `Couldn't run this check — ${err instanceof Error ? err.message : String(err)}.`,
          fix: null,
        };
      }
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    checks,
    fails: checks.filter((c) => c.status === 'fail').length,
    warns: checks.filter((c) => c.status === 'warn').length,
  };
}

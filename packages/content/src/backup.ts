/**
 * Scheduled local DB backups — the user-facing backup feature.
 *
 * The brain (Postgres) is the irreplaceable part of a Mantle install, so the
 * app itself dumps it on a schedule to a LOCAL directory the operator picks at
 * /settings/backups. Getting that directory offsite is deliberately out of
 * scope: every operator has a different story (rsync cron, rclone, restic,
 * Syncthing, Time Machine), and all of them work by pointing at the backup
 * directory. Mantle's job ends at producing verified, rotated dumps there.
 *
 * Mechanics:
 *   - `pg_dump -Fc --no-owner` against DATABASE_URL, streamed to
 *     `mantle-<ts>.dump` via a `.part` temp name (a partial dump can never be
 *     mistaken for a good one), then checked for the PGDMP magic bytes.
 *   - Rotation keeps the newest `keep` dumps in the directory; only files
 *     matching our own `mantle-*.dump` pattern are ever touched.
 *   - The scheduler is a cheap hour-match tick hosted by the events worker
 *     (`maybeRunScheduledBackup`): when the wall-clock hour in the user's
 *     timezone equals the configured hour (and the last run is old enough to
 *     rule out a double-fire), it runs. No cron table, no extra process —
 *     but it only fires while the events worker is up.
 *   - Config + last-run status live on profiles.preferences (top-level
 *     `backup` / `backupStatus` keys, jsonb-merged) so the settings UI and
 *     the worker share one source of truth.
 *
 * Object bytes (data/minio) and host files (data/files) are already plain
 * files on disk next to this directory in the default layout — the offsite
 * copy should include them; the settings page says so.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, profiles } from '@mantle/db';
import { loadProfilePreferences } from './profile-preferences';

export type BackupFrequency = 'daily' | 'weekly';

export type BackupConfig = {
  enabled: boolean;
  frequency: BackupFrequency;
  /** Hour of day (0-23) in the USER's timezone (profiles.preferences.timezone). */
  hour: number;
  /** Newest N dumps retained in the directory. */
  keep: number;
  /** Absolute destination directory. Empty/unset → resolveBackupDir default. */
  location?: string;
};

export type BackupStatus = {
  lastRunAt: string;
  ok: boolean;
  /** Set when ok=false. */
  error?: string;
  file?: string;
  bytes?: number;
  durationMs?: number;
  /** 'schedule' | 'manual' — what triggered the run. */
  trigger: string;
  /** When the last SUCCESSFUL run finished — preserved across failed runs,
   *  so the /debug/integrity staleness check can tell "failing for a week"
   *  from "failed once after last night's good dump". */
  lastSuccessAt?: string;
};

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  frequency: 'daily',
  hour: 2,
  keep: 7,
};

/** Destination resolution: explicit setting → MANTLE_BACKUP_DIR env (the
 *  compose file points it at the mounted ${MANTLE_DATA_DIR}/backups) →
 *  `data/backups` under the working directory (dev). `~` expands. */
export function resolveBackupDir(cfg?: Pick<BackupConfig, 'location'> | null): string {
  const raw =
    (cfg?.location ?? '').trim() ||
    (process.env.MANTLE_BACKUP_DIR ?? '').trim() ||
    path.join(process.cwd(), 'data', 'backups');
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

export async function loadBackupConfig(userId: string): Promise<BackupConfig> {
  const [row] = await db
    .select({ preferences: profiles.preferences })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const raw = ((row?.preferences ?? {}) as Record<string, unknown>).backup;
  return normalizeBackupConfig(raw);
}

export function normalizeBackupConfig(raw: unknown): BackupConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const hour = Number(o.hour);
  const keep = Number(o.keep);
  return {
    enabled: o.enabled === true,
    frequency: o.frequency === 'weekly' ? 'weekly' : 'daily',
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_BACKUP_CONFIG.hour,
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 365 ? keep : DEFAULT_BACKUP_CONFIG.keep,
    location: typeof o.location === 'string' && o.location.trim() ? o.location.trim() : undefined,
  };
}

export async function saveBackupConfig(userId: string, cfg: BackupConfig): Promise<void> {
  const merge = JSON.stringify({ backup: cfg });
  await db
    .update(profiles)
    .set({ preferences: sql`${profiles.preferences} || ${merge}::jsonb`, updatedAt: new Date() })
    .where(eq(profiles.userId, userId));
}

export async function loadBackupStatus(userId: string): Promise<BackupStatus | null> {
  const [row] = await db
    .select({ preferences: profiles.preferences })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const raw = ((row?.preferences ?? {}) as Record<string, unknown>).backupStatus as
    | BackupStatus
    | undefined;
  return raw && typeof raw.lastRunAt === 'string' ? raw : null;
}

async function writeBackupStatus(userId: string, status: BackupStatus): Promise<void> {
  const merge = JSON.stringify({ backupStatus: status });
  await db
    .update(profiles)
    .set({ preferences: sql`${profiles.preferences} || ${merge}::jsonb`, updatedAt: new Date() })
    .where(eq(profiles.userId, userId));
}

/** Locate a pg_dump binary: MANTLE_PG_DUMP env wins outright; otherwise the
 *  first candidate that actually RUNS (`--version` probe — an `access` check
 *  can't cover bare PATH names) out of: PATH, pgdg (the Docker image ships
 *  postgresql-client-17 to match the bundled Postgres 17), homebrew libpq.
 *  Null when nothing runs — the caller turns that into an actionable error. */
async function resolvePgDump(): Promise<string | null> {
  const explicit = (process.env.MANTLE_PG_DUMP ?? '').trim();
  if (explicit) return explicit;
  const candidates = [
    'pg_dump',
    '/usr/lib/postgresql/17/bin/pg_dump',
    '/opt/homebrew/opt/libpq/bin/pg_dump',
    '/usr/local/opt/libpq/bin/pg_dump',
  ];
  for (const c of candidates) {
    if (await canRun(c)) return c;
  }
  return null;
}

function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export type BackupFile = { name: string; bytes: number; mtime: string };

const DUMP_RE = /^mantle-\d{8}-\d{6}\.dump$/;

/** Newest-first listing of dumps in the configured directory. Missing
 *  directory → empty list (nothing has run yet). */
export async function listBackups(cfg?: BackupConfig | null): Promise<BackupFile[]> {
  const dir = resolveBackupDir(cfg);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    if (!DUMP_RE.test(name)) continue;
    try {
      const s = await stat(path.join(dir, name));
      out.push({ name, bytes: s.size, mtime: s.mtime.toISOString() });
    } catch {
      // raced a rotation — skip
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

// One backup at a time per process — Run-now and the scheduler must not
// overlap (two pg_dumps are harmless but wasteful; interleaved rotation isn't).
let inflight: Promise<BackupStatus> | null = null;

export async function runBackup(
  userId: string,
  trigger: 'schedule' | 'manual',
): Promise<BackupStatus> {
  if (inflight) return inflight;
  const p = runBackupInner(userId, trigger).finally(() => {
    inflight = null;
  });
  inflight = p;
  return p;
}

async function runBackupInner(
  userId: string,
  trigger: 'schedule' | 'manual',
): Promise<BackupStatus> {
  const started = Date.now();
  // Carried into both outcomes: a failed run must not erase the record of
  // when the last GOOD dump happened (the staleness check keys on it).
  const prior = await loadBackupStatus(userId);
  const priorSuccessAt =
    prior?.lastSuccessAt ?? (prior?.ok ? prior.lastRunAt : undefined);
  const fail = async (error: string): Promise<BackupStatus> => {
    const status: BackupStatus = {
      lastRunAt: new Date().toISOString(),
      ok: false,
      error,
      trigger,
      ...(priorSuccessAt ? { lastSuccessAt: priorSuccessAt } : {}),
    };
    console.error(`[backup] ✗ ${error}`);
    await writeBackupStatus(userId, status);
    return status;
  };

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return fail('DATABASE_URL is not set in this process');

  const cfg = await loadBackupConfig(userId);
  const dir = resolveBackupDir(cfg);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return fail(`cannot create backup directory ${dir}: ${msg(err)}`);
  }

  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const finalPath = path.join(dir, `mantle-${ts}.dump`);
  const partPath = `${finalPath}.part`;

  const bin = await resolvePgDump();
  if (!bin) {
    return fail(
      'no runnable pg_dump found. Install a Postgres 17+ client (Docker images ship it; on macOS `brew install libpq`) or set MANTLE_PG_DUMP to the binary.',
    );
  }
  const exit = await new Promise<{ code: number | null; stderr: string; spawnErr?: string }>(
    (resolve) => {
      const child = spawn(bin, ['--dbname', databaseUrl, '-Fc', '--no-owner'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = createWriteStream(partPath);
      child.stdout.pipe(out);
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', (err) => resolve({ code: null, stderr, spawnErr: msg(err) }));
      child.on('close', (code) => {
        out.end(() => resolve({ code, stderr }));
      });
    },
  );

  if (exit.spawnErr) {
    await unlink(partPath).catch(() => {});
    return fail(
      `could not run pg_dump (${bin}): ${exit.spawnErr}. Install a Postgres 17 client or set MANTLE_PG_DUMP to the binary.`,
    );
  }
  if (exit.code !== 0) {
    await unlink(partPath).catch(() => {});
    return fail(`pg_dump exited ${exit.code}: ${exit.stderr.slice(0, 500)}`);
  }

  // A custom-format archive starts with "PGDMP" — verify before promoting.
  try {
    const fh = await open(partPath, 'r');
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    await fh.close();
    if (buf.toString('latin1') !== 'PGDMP') {
      await unlink(partPath).catch(() => {});
      return fail('dump is not a valid pg_dump custom-format archive (bad magic bytes)');
    }
  } catch (err) {
    await unlink(partPath).catch(() => {});
    return fail(`could not verify dump: ${msg(err)}`);
  }

  await rename(partPath, finalPath);
  const { size } = await stat(finalPath);

  // Rotate: newest `keep` survive. Only our own mantle-*.dump names are
  // candidates, so manual files in the same directory are never touched.
  const existing = await listBackups(cfg);
  for (const old of existing.slice(Math.max(1, cfg.keep))) {
    await unlink(path.join(dir, old.name)).catch(() => {});
  }

  const finishedAt = new Date().toISOString();
  const status: BackupStatus = {
    lastRunAt: finishedAt,
    ok: true,
    file: finalPath,
    bytes: size,
    durationMs: Date.now() - started,
    trigger,
    lastSuccessAt: finishedAt,
  };
  console.log(
    `[backup] ✔ ${path.basename(finalPath)} (${Math.round(size / 1024 / 1024)}MB, ${status.durationMs}ms, ${trigger})`,
  );
  await writeBackupStatus(userId, status);
  return status;
}

/** Pure due-check, exported for tests. `now` vs `lastRunAt` in the user's
 *  timezone: due when the current wall-clock hour matches the configured
 *  hour (weekly additionally requires Sunday) and the last run is old
 *  enough that this can't be a double-fire within the same window. */
export function isBackupDue(
  cfg: BackupConfig,
  lastRunAt: string | null,
  now: Date,
  timezone: string,
): boolean {
  if (!cfg.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1) % 24;
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (hour !== cfg.hour) return false;
  if (cfg.frequency === 'weekly' && weekday !== 'Sun') return false;
  if (!lastRunAt) return true;
  const ageMs = now.getTime() - new Date(lastRunAt).getTime();
  const minAgeMs = cfg.frequency === 'weekly' ? 6 * 24 * 3600_000 : 20 * 3600_000;
  return ageMs >= minAgeMs;
}

let lastDueCheck = 0;

/** Cheap scheduler tick — call from any periodic loop (the events worker
 *  does, every 30s). Internally throttled to one check per minute; finds
 *  owners with backups enabled and runs theirs when due. Never throws. */
export async function maybeRunScheduledBackups(): Promise<void> {
  const now = Date.now();
  if (now - lastDueCheck < 60_000) return;
  lastDueCheck = now;
  try {
    const owners = await db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(sql`${profiles.preferences}->'backup'->>'enabled' = 'true'`);
    for (const { userId } of owners) {
      const cfg = await loadBackupConfig(userId);
      if (!cfg.enabled) continue;
      const [prefs, status] = await Promise.all([
        loadProfilePreferences(userId),
        loadBackupStatus(userId),
      ]);
      // A FAILED run also arms the double-fire guard (lastRunAt is written
      // on both outcomes) — otherwise a persistent failure would retry
      // every minute for the whole configured hour. One attempt per window;
      // the status banner in /settings/backups carries the error.
      if (!isBackupDue(cfg, status?.lastRunAt ?? null, new Date(), prefs.timezone)) continue;
      await runBackup(userId, 'schedule');
    }
  } catch (err) {
    console.error('[backup] scheduler tick error:', msg(err));
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

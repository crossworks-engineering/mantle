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
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, profiles } from '@mantle/db';
import { loadProfilePreferences } from './profile-preferences';
import { snapshotAllTableDatabases } from './table-storage';
import { snapshotAllAppDatabases } from './app-broker';

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
  /** Sqlite-native table workbooks snapshotted beside the dump (durability
   *  gate 2). failed>0 is surfaced in the settings card — a backup that
   *  silently skips a workbook is the gap this closes. */
  tableDbs?: { snapshotted: number; missing: number; failed: number };
  /** Per-app mini-app SQLite databases snapshotted beside the dump. Same
   *  durability gate as tableDbs: these live on their own volume, so pg_dump
   *  alone misses them and a scheduled backup would silently omit all app
   *  data (e.g. a Team Hub app's DB) without this pass. */
  appDbs?: { snapshotted: number; missing: number; failed: number };
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

// ── Ephemeral-location guard ────────────────────────────────────────────────
// The footgun this closes: in the prod container the operator can type any
// custom backup directory at /settings/backups. If that path is NOT under one
// of the persistent host bind-mounts, `mkdir -p` happily creates it inside the
// container's overlay (ephemeral) filesystem, pg_dump writes there, the run
// reports ok:true — and every "successful" dump is destroyed the next time the
// container is recreated (a redeploy, an update, a `compose down`). So we
// REJECT such a location rather than silently accept it.
//
// Only enforced INSIDE a container — a dev/native-node box has no overlay root
// and must be entirely unaffected (any local path is fine there).

type MountEntry = { device: string; mountpoint: string; fstype: string };

/** The kernel octal-escapes whitespace/backslash in /proc mount fields
 *  (space=\040, tab=\011, newline=\012, backslash=\134). Decode them. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Parse the CONTENT of /proc/self/mounts into (device, mountpoint, fstype)
 *  rows. Injectable so the persistence logic is unit-testable. */
export function parseProcMounts(content: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const [device, mountpoint, fstype] = line.split(' ');
    if (!device || !mountpoint || !fstype) continue;
    out.push({
      device: unescapeMountField(device),
      mountpoint: unescapeMountField(mountpoint),
      fstype: unescapeMountField(fstype),
    });
  }
  return out;
}

/** True when `mountpoint` is `dir` itself or a path-SEGMENT ancestor of it.
 *  Root ('/') is an ancestor of every absolute path. Segment-aware, NOT string
 *  prefix: '/data/back' is not an ancestor of '/data/backups'. */
function mountpointCovers(mountpoint: string, dir: string): boolean {
  if (mountpoint === dir) return true;
  if (mountpoint === '/') return dir.startsWith('/');
  return dir.startsWith(`${mountpoint}/`);
}

/**
 * Core, unit-testable persistence decision for a resolved backup directory.
 *
 * @param dir           absolute resolved backup directory
 * @param mountsContent contents of /proc/self/mounts, or null if unreadable
 * @param dockerEnv     whether /.dockerenv exists
 *
 * Not in a container → always persistent (dev is never enforced). In a
 * container we find the LONGEST mountpoint that covers `dir` and treat the dir
 * as ephemeral only when that winning mount's fstype is `overlay` (the
 * container's own writable layer). Unreadable mounts inside a container →
 * fail OPEN (persistent) so an exotic runtime can never brick backups.
 */
export function isResolvedBackupDirPersistent(
  dir: string,
  mountsContent: string | null,
  dockerEnv: boolean,
): boolean {
  const mounts = mountsContent != null ? parseProcMounts(mountsContent) : null;
  const rootIsOverlay =
    mounts?.some((m) => m.mountpoint === '/' && m.fstype === 'overlay') ?? false;
  const inContainer = dockerEnv || rootIsOverlay;
  if (!inContainer) return true; // dev / native node — never enforced
  if (!mounts) return true; // in a container but mounts unreadable → fail open
  let winner: MountEntry | null = null;
  for (const m of mounts) {
    if (
      mountpointCovers(m.mountpoint, dir) &&
      (!winner || m.mountpoint.length > winner.mountpoint.length)
    ) {
      winner = m;
    }
  }
  if (!winner) return true; // no covering mount (can't happen with '/') → fail open
  return winner.fstype !== 'overlay';
}

/** Thin wrapper: reads the real /.dockerenv + /proc/self/mounts and decides
 *  whether `dir` lives on persistent storage. Exported for the settings route
 *  and the backup runner. Never throws. */
export function isBackupDirPersistent(dir: string): boolean {
  let dockerEnv = false;
  try {
    dockerEnv = existsSync('/.dockerenv');
  } catch {
    dockerEnv = false;
  }
  let mountsContent: string | null = null;
  try {
    mountsContent = readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    mountsContent = null;
  }
  return isResolvedBackupDirPersistent(dir, mountsContent, dockerEnv);
}

/** Shared, plain-language error for an ephemeral backup location — used both at
 *  save time (the settings 400) and at run time (the backupStatus error) so the
 *  operator sees the same explanation in both places. */
export function ephemeralBackupDirMessage(dir: string): string {
  return (
    `Backup location ${dir} is inside the container's ephemeral filesystem — dumps ` +
    `written there are destroyed when the container is recreated. Use a path under a ` +
    `mounted directory (e.g. /data/backups) or clear the custom location.`
  );
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
  const priorSuccessAt = prior?.lastSuccessAt ?? (prior?.ok ? prior.lastRunAt : undefined);
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
  // Refuse to write into the container's ephemeral overlay: creating the dir
  // there would succeed and the dump would report ok, but every byte is lost on
  // the next container recreate. Better a loud failed status than a silent
  // "backup" that isn't one. (No-op on dev / native node.)
  if (!isBackupDirPersistent(dir)) {
    return fail(ephemeralBackupDirMessage(dir));
  }
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

  // Sqlite-native table workbooks (durability gate 2): VACUUM INTO snapshots
  // into a sibling directory, same timestamp, same rotation. Loud but
  // non-fatal — a workbook hiccup must not invalidate the Postgres dump, and
  // the counts land in the status so it can't be silent either.
  let tableDbs: BackupStatus['tableDbs'];
  try {
    const r = await snapshotAllTableDatabases(path.join(dir, `mantle-table-dbs-${ts}`));
    tableDbs = {
      snapshotted: r.snapshotted.length,
      missing: r.missing.length,
      failed: r.failed.length,
    };
    if (r.failed.length > 0 || r.missing.length > 0) {
      console.error(
        `[backup] ⚠ table workbooks: ${r.failed.map((f) => `${f.nodeId}: ${f.error}`).join('; ')}` +
          `${r.missing.length ? ` · missing files: ${r.missing.map((m) => m.nodeId).join(', ')}` : ''}`,
      );
    }
  } catch (err) {
    tableDbs = { snapshotted: 0, missing: 0, failed: -1 };
    console.error(`[backup] ⚠ table-workbook snapshot pass crashed: ${msg(err)}`);
  }

  // Per-app mini-app databases (durability gate 3): same VACUUM INTO snapshot,
  // same timestamp + rotation as table-dbs. These live on their own volume, so
  // pg_dump alone misses them — without this pass a SCHEDULED backup silently
  // omits all app data (only the manual db-dump.sh path snapshotted them
  // before). Loud but non-fatal, counts surfaced in the status.
  let appDbs: BackupStatus['appDbs'];
  try {
    const r = await snapshotAllAppDatabases(path.join(dir, `mantle-app-dbs-${ts}`));
    appDbs = {
      snapshotted: r.snapshotted.length,
      missing: r.missing.length,
      failed: r.failed.length,
    };
    if (r.failed.length > 0 || r.missing.length > 0) {
      console.error(
        `[backup] ⚠ app databases: ${r.failed.map((f) => `${f.appNodeId}: ${f.error}`).join('; ')}` +
          `${r.missing.length ? ` · missing files: ${r.missing.map((m) => m.appNodeId).join(', ')}` : ''}`,
      );
    }
  } catch (err) {
    appDbs = { snapshotted: 0, missing: 0, failed: -1 };
    console.error(`[backup] ⚠ app-database snapshot pass crashed: ${msg(err)}`);
  }

  // Rotate: newest `keep` survive — dumps AND their table-db sibling dirs.
  // Only our own mantle-* names are candidates, so manual files in the same
  // directory are never touched.
  const existing = await listBackups(cfg);
  for (const old of existing.slice(Math.max(1, cfg.keep))) {
    await unlink(path.join(dir, old.name)).catch(() => {});
    const stamp = old.name.replace(/^mantle-/, '').replace(/\.dump$/, '');
    await rm(path.join(dir, `mantle-table-dbs-${stamp}`), { recursive: true, force: true }).catch(
      () => {},
    );
    await rm(path.join(dir, `mantle-app-dbs-${stamp}`), { recursive: true, force: true }).catch(
      () => {},
    );
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
    ...(tableDbs ? { tableDbs } : {}),
    ...(appDbs ? { appDbs } : {}),
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

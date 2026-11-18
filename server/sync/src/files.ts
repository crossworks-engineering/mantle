/**
 * A drive run of the Sync sidecar (Sync service plan M3; M0 measured the
 * shape): one short `rclone lsjson -R --hash` lists the drive, read line by
 * line (flat memory at any size); the list is compared with the brain's file
 * map (GET /api/sidecar/files); each new or changed file goes to the brain
 * with one short `rclone cat`, its bytes streamed straight into
 * POST /api/sidecar/files (nothing on disk here). No rclone daemon and no
 * rclone config: the backend and a fresh access token go in by environment,
 * never on the command line.
 *
 * Re-link, never re-download, on a match: an item the map knows with the
 * same provider hash is left alone; one from the copied old map (no hash yet)
 * with the same size is re-linked (its hash taken from the list). A file gone
 * from the drive, or out of its selections, leaves the brain, but only after
 * a listing that ran to its end.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { errorMessage } from '@mantle/std';
import { BrainError, type Brain } from './brain';
import { accessToken, currentSelections, inSelections } from './microsoft';
import type { MsDrive, State } from './state';

/** The largest file a drive run takes: the brain's buffered upload cap
 *  (MAX_UPLOAD_BYTES), as before M4. A bigger one is skipped and counted. */
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
const BATCH = 500;
/** The most files one run fetches: a large first sync goes on in the next
 *  runs, so mail and feeds on the one lane do not wait for hours. Removal
 *  is not held back (the listing still names every file). */
export const FETCH_MAX = 300;
const ERROR_MAX = 300;
/** rclone's onedrive remote, named in its environment only. */
const REMOTE = 'ms';

/** One file of a drive listing. `path` is after the drive root, from `/`. */
export type Listed = {
  id: string;
  path: string;
  name: string;
  size: number;
  modTime: string | null;
  hash: string | null;
};

/** The hash a listing names, as `<kind>:<value>`: OneDrive's QuickXorHash
 *  first, then SHA-1, SHA-256, MD5. Null when none. */
export function pickHash(hashes: Record<string, string> | undefined): string | null {
  if (!hashes) return null;
  for (const kind of ['quickxor', 'sha1', 'sha256', 'md5']) {
    const v = hashes[kind];
    if (v) return `${kind}:${v}`;
  }
  return null;
}

/** One line of `rclone lsjson` output: a file, null for the array's own
 *  lines (`[`, `]`, empty), or 'bad' for a line that is not an item. */
export function parseLsjsonLine(line: string): Listed | null | 'bad' {
  let t = line.trim();
  if (t === '' || t === '[' || t === ']') return null;
  if (t.endsWith(',')) t = t.slice(0, -1);
  let o: {
    Path?: unknown;
    Name?: unknown;
    Size?: unknown;
    ModTime?: unknown;
    IsDir?: unknown;
    ID?: unknown;
    Hashes?: Record<string, string>;
  };
  try {
    o = JSON.parse(t) as typeof o;
  } catch {
    return 'bad';
  }
  if (typeof o.Path !== 'string' || typeof o.Name !== 'string') return 'bad';
  if (o.IsDir === true) return null;
  const path = `/${o.Path}`;
  return {
    // A backend that names no id (none of Microsoft's): the path stands in.
    id: typeof o.ID === 'string' && o.ID ? o.ID : `path:${path}`,
    path,
    name: o.Name,
    size: typeof o.Size === 'number' && o.Size >= 0 ? o.Size : 0,
    modTime: typeof o.ModTime === 'string' ? o.ModTime : null,
    hash: pickHash(o.Hashes),
  };
}

export type MapRow = {
  itemId: string;
  hash: string | null;
  size: number | null;
  /** When the item last changed, as the map knows it (ISO). */
  modTime: string | null;
};

/** The listed time is not after the map's (a second's slack). */
function notNewer(listed: string | null, known: string | null): boolean {
  if (!listed || !known) return false;
  const a = Date.parse(listed);
  const b = Date.parse(known);
  return Number.isFinite(a) && Number.isFinite(b) && a <= b + 1000;
}

export type Plan = {
  /** Files to fetch: new, or changed. */
  fetch: Listed[];
  /** Files the map knows from the old sync, unchanged: their hash taken. */
  relink: Listed[];
  /** Ids listed and in the selections (kept). */
  seen: Set<string>;
  /** Files over the size cap (not fetched; an old copy is kept). */
  oversize: number;
};

/** What one listed file needs, given the map. Pure (the tests call it). */
export function planItem(
  plan: Plan,
  map: Map<string, MapRow>,
  drive: Pick<MsDrive, 'selections'>,
  item: Listed,
): void {
  if (!inSelections(drive.selections, item.id.startsWith('path:') ? undefined : item.id, item.path))
    return;
  plan.seen.add(item.id);
  if (item.size > FILE_MAX_BYTES) {
    plan.oversize += 1;
    return;
  }
  const known = map.get(item.id);
  if (known?.hash && item.hash && known.hash === item.hash) return;
  // A copied old row (no hash yet): re-linked only when its size is the
  // same and it has not changed since the old sync's last run.
  if (known && !known.hash && known.size === item.size && notNewer(item.modTime, known.modTime)) {
    plan.relink.push(item);
    return;
  }
  plan.fetch.push(item);
}

/** Ids the map holds that the listing did not keep: they leave the brain. */
export function goneIds(map: Map<string, MapRow>, seen: Set<string>): string[] {
  return [...map.keys()].filter((id) => !seen.has(id));
}

/** rclone's drive type for a Graph driveType. */
function rcloneDriveType(t: string): string {
  return t === 'personal' ? 'personal' : t === 'documentLibrary' ? 'documentLibrary' : 'business';
}

/** The environment of one rclone command: the backend and the token, and
 *  nothing of the sidecar's own (its token never reaches rclone). */
async function rcloneEnv(state: State, drive: MsDrive): Promise<Record<string, string>> {
  const token = await accessToken(state, drive.accountId);
  const account = await state.msAccount(drive.accountId);
  const expiry = new Date(account?.expiresAt ?? Date.now() + 30 * 60_000).toISOString();
  const k = `RCLONE_CONFIG_${REMOTE.toUpperCase()}`;
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    [`${k}_TYPE`]: 'onedrive',
    [`${k}_DRIVE_ID`]: drive.driveId,
    [`${k}_DRIVE_TYPE`]: rcloneDriveType(drive.driveType),
    // A recursive listing reads the drive's delta in one walk.
    [`${k}_DELTA`]: 'true',
    [`${k}_TOKEN`]: JSON.stringify({ access_token: token, token_type: 'Bearer', expiry }),
  };
}

/** rclone's last stderr line, short (it names no token). */
const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, ERROR_MAX) ?? '';

/** List the drive: each file to `onItem`. Whether the listing ran to its
 *  end (rclone exit 0 and every line read). */
async function listDrive(
  state: State,
  drive: MsDrive,
  onItem: (item: Listed) => void,
): Promise<{ complete: boolean; error?: string }> {
  const child = spawn(
    'rclone',
    [
      'lsjson',
      '-R',
      '--hash',
      '--files-only',
      '--no-mimetype',
      '--fast-list',
      '--config',
      '/dev/null',
      `${REMOTE}:`,
    ],
    { env: await rcloneEnv(state, drive), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-4000);
  });
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
  let bad = 0;
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    const item = parseLsjsonLine(line);
    if (item === 'bad') bad += 1;
    else if (item) onItem(item);
  }
  const code = await exited;
  if (code !== 0) return { complete: false, error: `rclone lsjson failed: ${lastLine(stderr)}` };
  return bad ? { complete: false, error: `${bad} listing line(s) unread` } : { complete: true };
}

/** The drive's file map in the brain, every page. */
async function loadMap(brain: Brain, source: string): Promise<Map<string, MapRow>> {
  const map = new Map<string, MapRow>();
  let after: string | null = null;
  for (;;) {
    const q: URLSearchParams = new URLSearchParams({ source, ...(after ? { after } : {}) });
    const r: { items: MapRow[] } = await brain.get<{ items: MapRow[] }>(`/api/sidecar/files?${q}`);
    for (const row of r.items) map.set(row.itemId, row);
    if (r.items.length === 0) break;
    after = r.items[r.items.length - 1]!.itemId;
  }
  return map;
}

/** Stream one file into the brain. 'skipped' when the brain refused this
 *  one file (400 or 413), so one odd file never stops a drive. */
async function fetchOne(
  brain: Brain,
  state: State,
  drive: MsDrive,
  path: string,
  item: Listed,
): Promise<{ kind: 'stored' } | { kind: 'skipped' } | { kind: 'failed'; why: string }> {
  const child = spawn(
    'rclone',
    ['cat', '--config', '/dev/null', `${REMOTE}:${item.path.slice(1)}`],
    {
      env: await rcloneEnv(state, drive),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-4000);
  });
  const ctrl = new AbortController();
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
  // rclone failed mid-file: the upload stops, so no part of a file is stored.
  void exited.then((code) => {
    if (code !== 0) ctrl.abort();
  });
  const q = new URLSearchParams({
    source: drive.id,
    item: item.id,
    path,
    name: item.name,
    size: String(item.size),
    ...(item.hash ? { hash: item.hash } : {}),
    ...(item.modTime ? { mod: item.modTime } : {}),
  });
  try {
    await brain.stream(
      `/api/sidecar/files?${q}`,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ctrl.signal,
    );
  } catch (err) {
    // rclone ended on its own with an error: that is the failure. Else the
    // brain (or the road to it) stopped first, and rclone is stopped here.
    const done = child.exitCode !== null || child.signalCode !== null;
    // This one file could not be downloaded (Microsoft refused it): the run
    // goes on without it, and tries it again next time.
    if (done && child.exitCode !== 0) return { kind: 'failed', why: lastLine(stderr) };
    if (!done) child.kill('SIGKILL');
    await exited;
    if (err instanceof BrainError && (err.status === 400 || err.status === 413)) {
      return { kind: 'skipped' };
    }
    throw err;
  }
  const code = await exited;
  if (code !== 0) return { kind: 'failed', why: lastLine(stderr) };
  return { kind: 'stored' };
}

export type DriveRun = {
  listed: number;
  fetched: number;
  relinked: number;
  removed: number;
  skipped: number;
};

/** One run of a drive, kept as its status. */
export async function runDrive(brain: Brain, state: State, drive: MsDrive): Promise<DriveRun> {
  const run: DriveRun = { listed: 0, fetched: 0, relinked: 0, removed: 0, skipped: 0 };
  let error: string | undefined;
  try {
    const account = await state.msAccount(drive.accountId);
    if (!account) throw new Error('its Microsoft account is not connected');
    const path = `${account.branchPath}.${drive.branchLabel}`;
    // Each chosen folder's path as it is now (a renamed folder keeps
    // syncing; its files are not taken for gone).
    const chosen = { selections: await currentSelections(state, drive) };
    const map = await loadMap(brain, drive.id);
    const plan: Plan = { fetch: [], relink: [], seen: new Set(), oversize: 0 };
    const listing = await listDrive(state, drive, (item) => {
      run.listed += 1;
      planItem(plan, map, chosen, item);
    });
    run.skipped += plan.oversize;
    for (let i = 0; i < plan.relink.length; i += BATCH) {
      const r = await brain.post<{ relinked: number }>('/api/sidecar/files/relink', {
        source: drive.id,
        items: plan.relink.slice(i, i + BATCH).map((it) => ({
          itemId: it.id,
          hash: it.hash,
          size: it.size,
          modTime: it.modTime,
        })),
      });
      run.relinked += r.relinked;
    }
    let failed = 0;
    let lastFailure = '';
    let tried = 0;
    for (const item of plan.fetch) {
      // The cap counts stored files: a file refused every run never holds
      // back the ones after it.
      if (run.fetched >= FETCH_MAX) break;
      tried += 1;
      const got = await fetchOne(brain, state, drive, path, item);
      if (got.kind === 'stored') run.fetched += 1;
      else if (got.kind === 'skipped') run.skipped += 1;
      else {
        failed += 1;
        lastFailure = got.why;
      }
    }
    if (failed) {
      error = `${failed} file(s) could not be downloaded; the last: ${lastFailure}`.slice(
        0,
        ERROR_MAX,
      );
    }
    if (listing.complete) {
      const gone = goneIds(map, plan.seen);
      for (let i = 0; i < gone.length; i += BATCH) {
        const r = await brain.post<{ removed: number }>('/api/sidecar/files/remove', {
          source: drive.id,
          itemIds: gone.slice(i, i + BATCH),
        });
        run.removed += r.removed;
      }
    } else {
      // A listing that stopped early removes nothing: a file it missed is
      // not gone.
      error = [error, listing.error].filter(Boolean).join('; ').slice(0, ERROR_MAX);
    }
    if (tried < plan.fetch.length) {
      console.warn(
        `[sync] drive ${drive.id}: ${plan.fetch.length - tried} file(s) left for the next run`,
      );
    }
  } catch (err) {
    error = errorMessage(err).slice(0, ERROR_MAX);
  }
  if (error) console.warn(`[sync] drive ${drive.id} run: ${error}`);
  await state.putStatus(drive.id, {
    at: new Date().toISOString(),
    ok: !error,
    ...(error ? { error } : {}),
    count: run.fetched + run.relinked,
  });
  return run;
}

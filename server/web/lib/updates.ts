/**
 * In-app updates — the DETECTION half (/settings/updates).
 *
 * Two concerns, deliberately separated from execution:
 *   1. Release check — GitHub releases API vs the running APP_VERSION.
 *      Cached in-module (6h TTL) so the unauthenticated 60-req/h limit is
 *      never a factor; "Check now" forces a refresh.
 *   2. Updater signalling — file IO against the `mantle_update_signal`
 *      volume shared with the updater sidecar (docker-compose.yml). The web
 *      app only ever WRITES a request file and READS status/log back; the
 *      sidecar (infra/updater/updater.sh) is the only thing that touches
 *      Docker. No signal dir mounted (dev, or a stack without the sidecar)
 *      → everything degrades to "updater not available".
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '@mantle/client-types/version';
import type { ComposeStatus, UpdateCheck, UpdaterStatus } from '@mantle/client-types';
import type {
  UpdaterPhase,
  UpdaterScriptState,
  ComposeState,
  ReleaseInfo,
} from '@mantle/client-types';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';

export type { UpdaterPhase, UpdaterScriptState, ComposeState, ReleaseInfo };
export type { ComposeStatus, UpdateCheck, UpdaterStatus };

export const RELEASES_REPO = 'crossworks-engineering/mantle';
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
/** The owner UI ships from its own repo (and its own version stream) since
 *  the 2026-08 split — the check watches BOTH, or UI releases are invisible. */
export const CLIENT_RELEASES_REPO = 'crossworks-engineering/jackdaw';
export const CLIENT_RELEASES_URL = `https://github.com/${CLIENT_RELEASES_REPO}/releases`;

/** The jackdaw client tag this server build was released against — the
 *  "release pair". Baked into the image beside the canonical compose files
 *  (Dockerfile → /app/release/client-tag, from client-pair.tag at the repo
 *  root); the updater sidecar reads the same file from the TARGET image when
 *  it rolls. Null in dev checkouts without the file and on pre-pair images. */
const RELEASE_CLIENT_TAG_PATH = env('MANTLE_RELEASE_CLIENT_TAG_PATH') ?? '/app/release/client-tag';
let pairedTagCache: string | null | undefined;
async function pairedClientTag(): Promise<string | null> {
  if (pairedTagCache !== undefined) return pairedTagCache;
  // Candidates: the baked image path, then the repo-root file for source
  // checkouts — whose relative position depends on who is running (tsx dev
  // serves from server/web, the test runner from the repo root).
  for (const p of [
    RELEASE_CLIENT_TAG_PATH,
    path.resolve(process.cwd(), '../../client-pair.tag'),
    path.resolve(process.cwd(), 'client-pair.tag'),
  ]) {
    try {
      const tag = (await fs.readFile(p, 'utf8')).trim();
      if (/^[A-Za-z0-9._-]+$/.test(tag)) {
        pairedTagCache = tag;
        return tag;
      }
    } catch {
      // try the next candidate
    }
  }
  pairedTagCache = null;
  return null;
}

const SIGNAL_DIR = env('MANTLE_UPDATE_SIGNAL_DIR') ?? '/signal';
/** How long a POSITIVE result (a newer release exists) stays cached. Once true
 *  it stays true until the box updates, so re-checking often buys nothing. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a NEGATIVE/error result (up-to-date, or the check failed) stays
 *  cached. Much shorter than the positive TTL so a release published shortly
 *  after this process last checked surfaces in the banner within minutes
 *  instead of being suppressed for up to 6h — the exact trap a box hits when it
 *  restarts just before a release goes out. Still one GitHub call per half-hour
 *  per process at most, far under the unauthenticated 60-req/h limit. */
const STALE_TTL_MS = 30 * 60 * 1000;

// ── release check ────────────────────────────────────────────────────────────

/** Numeric segment-wise semver compare; pre-release suffixes (-alpha) are
 *  ignored for ordering. >0 when a > b. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

let cachedCheck: UpdateCheck | null = null;

/** Latest release of one repo via the GitHub API. Failure is a value, not a
 *  throw — each stream degrades independently (a jackdaw rate-limit must not
 *  hide a mantle release, or vice versa). */
async function fetchLatestRelease(
  repo: string,
  fallbackUrl: string,
): Promise<{ latest: ReleaseInfo | null; error: string | null }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `mantle/${APP_VERSION}`,
      },
      // Next would otherwise cache the fetch in the data cache; we manage our
      // own TTL + force semantics.
      cache: 'no-store',
    });
    if (!res.ok) {
      // 404 = no releases published yet — a state, not a failure worth a toast.
      return {
        latest: null,
        error:
          res.status === 404
            ? 'No releases published yet.'
            : `GitHub API: ${res.status} ${res.statusText}`,
      };
    }
    const body = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
    };
    const tag = body.tag_name ?? '';
    if (!tag) return { latest: null, error: 'Release response carried no tag.' };
    return {
      latest: {
        tag,
        version: tag.replace(/^v/, ''),
        name: body.name || tag,
        url: body.html_url ?? fallbackUrl,
        publishedAt: body.published_at ?? null,
      },
      error: null,
    };
  } catch (err) {
    return { latest: null, error: errorMessage(err) };
  }
}

export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  if (!force && cachedCheck) {
    // A confirmed update gets the long TTL; "no update" or an error gets the
    // short one, so a freshly published release isn't masked for hours.
    const ttl = cachedCheck.updateAvailable ? CHECK_TTL_MS : STALE_TTL_MS;
    if (Date.now() - new Date(cachedCheck.checkedAt).getTime() < ttl) {
      return cachedCheck;
    }
  }
  const checkedAt = new Date().toISOString();
  const [server, client, pairedTag] = await Promise.all([
    fetchLatestRelease(RELEASES_REPO, RELEASES_URL),
    fetchLatestRelease(CLIENT_RELEASES_REPO, CLIENT_RELEASES_URL),
    pairedClientTag(),
  ]);
  cachedCheck = {
    currentVersion: APP_VERSION,
    latest: server.latest,
    updateAvailable: !!server.latest && compareVersions(server.latest.version, APP_VERSION) > 0,
    checkedAt,
    error: server.error,
    // Whether the INTERFACE is out of date is decided in the browser: only the
    // client build knows its own version, so this just carries the facts.
    client: { latest: client.latest, pairedTag, error: client.error },
  };
  return cachedCheck;
}

// ── updater signalling ───────────────────────────────────────────────────────

/** Whether the signal volume is mounted and writable (i.e. the updater
 *  sidecar deployment shape is in place). */
export async function updaterAvailable(): Promise<boolean> {
  try {
    await fs.access(SIGNAL_DIR, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readUpdaterStatus(): Promise<UpdaterStatus | null> {
  try {
    // A request the sidecar hasn't consumed yet reads as its own phase, so the
    // UI shows progress immediately instead of a stale prior status.
    const pending = await fs
      .access(path.join(SIGNAL_DIR, 'request.json'))
      .then(() => true)
      .catch(() => false);
    const raw = await fs.readFile(path.join(SIGNAL_DIR, 'status.json'), 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    const status: UpdaterStatus = {
      phase: (typeof j.phase === 'string' ? j.phase : 'idle') as UpdaterPhase,
      target: typeof j.target === 'string' ? j.target : '',
      startedAt: typeof j.started_at === 'string' && j.started_at ? j.started_at : null,
      finishedAt: typeof j.finished_at === 'string' && j.finished_at ? j.finished_at : null,
      ok: typeof j.ok === 'boolean' ? j.ok : null,
      error: typeof j.error === 'string' && j.error ? j.error : null,
    };
    if (
      pending &&
      (status.phase === 'idle' || status.phase === 'done' || status.phase === 'error')
    ) {
      return { ...status, phase: 'requested', error: null };
    }
    return status;
  } catch {
    return null;
  }
}

// ── compose drift (release-owned compose contract) ──────────────────────────
// The canonical docker-compose.yml ships INSIDE this image (Dockerfile →
// /app/release/docker-compose.yml); the updater sidecar fingerprints the box's
// actual stack files into /signal/stack.json (it mounts the stack dir — this
// container can't see the host compose directly). Comparing the two flags
// "image is release X but compose is from release Y" even on boxes where the
// auto-refresh can't run. See infra/updater/updater.sh + docs/deploy.md.

const RELEASE_COMPOSE_PATH =
  env('MANTLE_RELEASE_COMPOSE_PATH') ?? '/app/release/docker-compose.yml';
const RELEASE_CLIENT_COMPOSE_PATH =
  env('MANTLE_RELEASE_CLIENT_COMPOSE_PATH') ?? '/app/release/docker-compose.client.yml';
const RELEASE_UPDATER_PATH = env('MANTLE_RELEASE_UPDATER_PATH') ?? '/app/release/updater.sh';

/** Canonical-compose hashes are constant for the life of the build. */
const canonicalShaCache = new Map<string, string | null>();

async function canonicalSha(path_: string): Promise<string | null> {
  const hit = canonicalShaCache.get(path_);
  if (hit !== undefined) return hit;
  let sha: string | null;
  try {
    const buf = await fs.readFile(path_);
    sha = createHash('sha256').update(buf).digest('hex');
  } catch {
    sha = null; // dev / pre-embed image
  }
  canonicalShaCache.set(path_, sha);
  return sha;
}

function classify(boxSha: string, baselineSha: string, canonical: string | null): ComposeState {
  if (!canonical || !boxSha) return 'unknown';
  if (boxSha === canonical) return 'in-sync';
  if (!baselineSha) return 'no-baseline';
  if (boxSha === baselineSha) return 'stale';
  return 'modified';
}

/** Same shape as classify(), minus 'no-baseline' — an absent baseline means
 *  "not adopted yet", which the script resolves by itself, so it reads as the
 *  plain 'stale' it functionally is. A baseline that EXISTS and disagrees is
 *  the one case a human must resolve. */
function classifyUpdater(
  boxSha: string,
  baselineSha: string,
  canonical: string | null,
): UpdaterScriptState {
  if (!canonical || !boxSha) return 'unknown';
  if (boxSha === canonical) return 'in-sync';
  if (baselineSha && boxSha !== baselineSha) return 'modified';
  return 'stale';
}

export async function readComposeStatus(): Promise<ComposeStatus> {
  const none = {
    state: 'unknown' as const,
    refresh: null,
    client: { state: 'unknown' as const, refresh: null },
    updater: { state: 'unknown' as const, refresh: null },
    checkedAt: null,
  };
  try {
    const [raw, canonical, clientCanonical, updaterCanonical] = await Promise.all([
      fs.readFile(path.join(SIGNAL_DIR, 'stack.json'), 'utf8'),
      canonicalSha(RELEASE_COMPOSE_PATH),
      canonicalSha(RELEASE_CLIENT_COMPOSE_PATH),
      canonicalSha(RELEASE_UPDATER_PATH),
    ]);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : '');
    const refresh = str('refresh') || null;
    const checkedAt = str('checked_at') || null;
    const state = classify(str('compose_sha'), str('baseline_sha'), canonical);
    // Client compose: an empty sha with refresh 'absent' (or an old updater
    // that reports no client fields at all) = a server-only box.
    const clientRefresh = str('client_refresh') || null;
    const client =
      clientRefresh === 'absent' || (!str('client_compose_sha') && !clientRefresh)
        ? { state: 'absent' as const, refresh: clientRefresh }
        : {
            state: classify(str('client_compose_sha'), str('client_baseline_sha'), clientCanonical),
            refresh: clientRefresh,
          };
    const updater = {
      state: classifyUpdater(str('updater_sha'), str('updater_baseline_sha'), updaterCanonical),
      refresh: str('updater_refresh') || null,
    };
    return { state, refresh, client, updater, checkedAt };
  } catch {
    return none;
  }
}

/** Tail of the updater's pull/up output for the progress view. */
export async function readUpdaterLog(maxLines = 60): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(SIGNAL_DIR, 'update.log'), 'utf8');
    const lines = raw.split('\n');
    return lines
      .slice(Math.max(0, lines.length - maxLines))
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

/** Ask the sidecar to update. `target` is the SERVER image tag ("v0.20.68" or
 *  "latest"); `clientTarget` is the owner-UI (jackdaw) tag. Either alone is
 *  valid: target-only rolls the server and lets the sidecar pair the client
 *  from the target image; clientTarget-only rolls just the interface.
 *  Validation mirrors the sidecar's own whitelist. */
export async function requestUpdate(
  target: string | null,
  clientTarget?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tag = target?.trim() ?? '';
  const clientTag = clientTarget?.trim() ?? '';
  if (!tag && !clientTag) return { ok: false, error: 'no update target given' };
  if (tag && !/^[A-Za-z0-9._-]+$/.test(tag)) return { ok: false, error: `invalid tag '${target}'` };
  if (clientTag && !/^[A-Za-z0-9._-]+$/.test(clientTag)) {
    return { ok: false, error: `invalid client tag '${clientTarget}'` };
  }
  if (!(await updaterAvailable())) {
    return { ok: false, error: 'updater sidecar not available on this deployment' };
  }
  const status = await readUpdaterStatus();
  // The sidecar is parked unconfigured (e.g. MANTLE_STACK_DIR missing from .env).
  // It will never consume the request, so refuse now with the reason rather than
  // letting the UI spin on a request that can't be picked up.
  if (status?.phase === 'unconfigured') {
    return {
      ok: false,
      error: status.error
        ? `updater is not configured: ${status.error}`
        : 'updater is not configured (set MANTLE_STACK_DIR in .env)',
    };
  }
  if (
    status &&
    (status.phase === 'pulling' || status.phase === 'rolling' || status.phase === 'requested')
  ) {
    return { ok: false, error: 'an update is already in progress' };
  }
  try {
    await fs.writeFile(
      path.join(SIGNAL_DIR, 'request.json'),
      JSON.stringify({
        // Key absence IS the signal: the sidecar treats a missing target as
        // "interface-only" when client_target is present.
        ...(tag ? { target: tag } : {}),
        ...(clientTag ? { client_target: clientTag } : {}),
        requested_at: new Date().toISOString(),
      }),
      'utf8',
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

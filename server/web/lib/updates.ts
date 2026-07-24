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
import { APP_VERSION } from '@mantle/web-ui/version';

export const RELEASES_REPO = 'crossworks-engineering/mantle';
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;

const SIGNAL_DIR = process.env.MANTLE_UPDATE_SIGNAL_DIR ?? '/signal';
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

export type ReleaseInfo = {
  /** Tag as published, e.g. "v0.20.67". */
  tag: string;
  /** Bare version, e.g. "0.20.67". */
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
};

export type UpdateCheck = {
  currentVersion: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  checkedAt: string;
  /** Set when the check itself failed (network, rate limit, no releases yet). */
  error: string | null;
};

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
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
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
      const error =
        res.status === 404
          ? 'No releases published yet.'
          : `GitHub API: ${res.status} ${res.statusText}`;
      cachedCheck = {
        currentVersion: APP_VERSION,
        latest: null,
        updateAvailable: false,
        checkedAt,
        error,
      };
      return cachedCheck;
    }
    const body = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
    };
    const tag = body.tag_name ?? '';
    const latest: ReleaseInfo | null = tag
      ? {
          tag,
          version: tag.replace(/^v/, ''),
          name: body.name || tag,
          url: body.html_url ?? RELEASES_URL,
          publishedAt: body.published_at ?? null,
        }
      : null;
    cachedCheck = {
      currentVersion: APP_VERSION,
      latest,
      updateAvailable: !!latest && compareVersions(latest.version, APP_VERSION) > 0,
      checkedAt,
      error: latest ? null : 'Release response carried no tag.',
    };
    return cachedCheck;
  } catch (err) {
    cachedCheck = {
      currentVersion: APP_VERSION,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    return cachedCheck;
  }
}

// ── updater signalling ───────────────────────────────────────────────────────

export type UpdaterPhase =
  'idle' | 'pulling' | 'rolling' | 'done' | 'error' | 'unconfigured' | 'requested';

export type UpdaterStatus = {
  phase: UpdaterPhase;
  target: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
};

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
  process.env.MANTLE_RELEASE_COMPOSE_PATH ?? '/app/release/docker-compose.yml';

export type ComposeState =
  | 'in-sync' // box compose == this release's canonical
  | 'stale' // pristine (== baseline) but not this release's — refresh hasn't run
  | 'modified' // hand-edited canonical file — auto-refresh disabled, needs adoption
  | 'no-baseline' // pre-adoption box — run scripts/compose-adopt.sh once
  | 'unknown'; // no stack.json (old updater.sh / no sidecar / dev)

export type ComposeStatus = {
  state: ComposeState;
  /** The updater's last refresh outcome verbatim (e.g. 'refreshed',
   *  'modified', 'no-baseline', 'unavailable'), for the details view. */
  refresh: string | null;
  checkedAt: string | null;
};

/** Canonical-compose hash is constant for the life of the build. */
let canonicalComposeSha: string | null | undefined;

async function releaseComposeSha(): Promise<string | null> {
  if (canonicalComposeSha !== undefined) return canonicalComposeSha;
  try {
    const buf = await fs.readFile(RELEASE_COMPOSE_PATH);
    canonicalComposeSha = createHash('sha256').update(buf).digest('hex');
  } catch {
    canonicalComposeSha = null; // dev / pre-embed image
  }
  return canonicalComposeSha;
}

export async function readComposeStatus(): Promise<ComposeStatus> {
  try {
    const [raw, canonical] = await Promise.all([
      fs.readFile(path.join(SIGNAL_DIR, 'stack.json'), 'utf8'),
      releaseComposeSha(),
    ]);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const composeSha = typeof j.compose_sha === 'string' ? j.compose_sha : '';
    const baselineSha = typeof j.baseline_sha === 'string' ? j.baseline_sha : '';
    const refresh = typeof j.refresh === 'string' && j.refresh ? j.refresh : null;
    const checkedAt = typeof j.checked_at === 'string' && j.checked_at ? j.checked_at : null;
    if (!canonical || !composeSha) return { state: 'unknown', refresh, checkedAt };
    let state: ComposeState;
    if (composeSha === canonical) state = 'in-sync';
    else if (!baselineSha) state = 'no-baseline';
    else if (composeSha === baselineSha) state = 'stale';
    else state = 'modified';
    return { state, refresh, checkedAt };
  } catch {
    return { state: 'unknown', refresh: null, checkedAt: null };
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

/** Ask the sidecar to update to `target` (an image tag like "v0.20.68", or
 *  "latest"). Validation mirrors the sidecar's own whitelist. */
export async function requestUpdate(
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tag = target.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) return { ok: false, error: `invalid tag '${target}'` };
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
      JSON.stringify({ target: tag, requested_at: new Date().toISOString() }),
      'utf8',
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

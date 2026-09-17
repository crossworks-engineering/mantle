import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_VERSION } from '@mantle/client-types/version';

/**
 * The release-check cache splits its TTL: a confirmed update is cached long
 * (6h — once true it stays true), but a "no update" / error result is cached
 * only briefly (30min) so a release published shortly after this process last
 * checked surfaces in the banner within minutes instead of being suppressed for
 * up to 6h. These tests pin that behaviour against the real `checkForUpdate`.
 */

const bumpMajor = (v: string): string => {
  const p = v
    .split('-')[0]!
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return `${(p[0] ?? 0) + 1}.0.0`;
};

let nextTag: string;
/** SERVER-repo release fetches only. One check hits GitHub once per repo
 *  (mantle + jackdaw since the split); the TTL contract under test is "how
 *  often does a CHECK happen", so we count checks via the mantle call and let
 *  the jackdaw call answer separately. */
let fetchCount: number;

function stubFetch() {
  fetchCount = 0;
  vi.stubGlobal('fetch', async (url: unknown) => {
    const isServerRepo = String(url).includes('/mantle/');
    if (isServerRepo) fetchCount += 1;
    const tag = isServerRepo ? nextTag : 'v0.0.1';
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: tag,
        name: tag,
        html_url: `https://example.test/${tag}`,
        published_at: '2026-06-30T15:17:39Z',
      }),
    } as unknown as Response;
  });
}

describe('checkForUpdate cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules(); // fresh module-level cache per test
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-checks a "no update" result after the short TTL, surfacing a just-published release', async () => {
    const { checkForUpdate } = await import('./updates');

    // 1) First check while we're on the latest → updateAvailable false, cached.
    nextTag = `v${APP_VERSION}`;
    let r = await checkForUpdate();
    expect(r.updateAvailable).toBe(false);
    expect(fetchCount).toBe(1);

    // 2) 20 min later (< 30min stale TTL) → served from cache, no new fetch.
    vi.advanceTimersByTime(20 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(false);
    expect(fetchCount).toBe(1);

    // 3) A new release goes out; 15 more min pass (35 total > 30min) → the stale
    //    negative is re-checked and the update is now seen.
    nextTag = `v${bumpMajor(APP_VERSION)}`;
    vi.advanceTimersByTime(15 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(r.latest?.tag).toBe(nextTag);
    expect(fetchCount).toBe(2);
  });

  it('carries the jackdaw (interface) stream beside the server stream', async () => {
    const { checkForUpdate } = await import('./updates');
    nextTag = `v${APP_VERSION}`;
    const r = await checkForUpdate(true);
    // The client stream is data, not a verdict: only the browser knows which
    // interface build it runs, so no updateAvailable is computed here.
    expect(r.client?.latest?.tag).toBe('v0.0.1');
    expect(r.client?.error).toBeNull();
    // The release pair (client-pair.tag at the repo root in dev, baked into
    // the image in prod) resolves to a plausible tag.
    expect(r.client?.pairedTag).toMatch(/^v\d/);
  });

  it('keeps a positive result cached past the short TTL (long TTL applies)', async () => {
    const { checkForUpdate } = await import('./updates');

    // A confirmed update.
    nextTag = `v${bumpMajor(APP_VERSION)}`;
    let r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(fetchCount).toBe(1);

    // 35 min later (> 30min stale TTL, but << 6h positive TTL) → still cached,
    // no extra GitHub call.
    vi.advanceTimersByTime(35 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(fetchCount).toBe(1);
  });
});

/**
 * Updater-script currency. The sidecar script is release-owned and, from
 * v0.206, self-refreshing — but the state that matters here is the one it
 * CAN'T fix: a hand-edited copy, which refuses to refresh and leaves the box
 * running old update logic. That is the shape of the 2026-07-26 fleet failure
 * (stale script rolls the server stack, reports ok, skips the client stack),
 * so these pin the classification that makes it visible.
 *
 * Deliberately not folded into the compose `classify`: the script has no
 * `no-baseline` standoff — it adopts — so an absent baseline must read as the
 * plain 'stale' it functionally is, never as an operator action.
 */
describe('readComposeStatus — updater script state', () => {
  const CANONICAL = '#!/bin/sh\necho canonical\n';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  let dir: string;

  /** Write a stack.json with the given updater fields and classify it. */
  async function stateFor(fields: Record<string, string>) {
    writeFileSync(
      join(dir, 'stack.json'),
      JSON.stringify({ compose_sha: '', baseline_sha: '', ...fields }),
    );
    vi.resetModules(); // canonical sha is cached per module instance
    const { readComposeStatus } = await import('./updates');
    return (await readComposeStatus()).updater.state;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mantle-updates-'));
    writeFileSync(join(dir, 'updater.sh'), CANONICAL);
    vi.stubEnv('MANTLE_UPDATE_SIGNAL_DIR', dir);
    vi.stubEnv('MANTLE_RELEASE_UPDATER_PATH', join(dir, 'updater.sh'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads in-sync when the box script matches this release', async () => {
    expect(
      await stateFor({ updater_sha: sha(CANONICAL), updater_baseline_sha: sha(CANONICAL) }),
    ).toBe('in-sync');
  });

  it('reads stale — not no-baseline — when an old script has no baseline yet', async () => {
    expect(await stateFor({ updater_sha: sha('#!/bin/sh\nold\n'), updater_baseline_sha: '' })).toBe(
      'stale',
    );
  });

  it('reads stale when an old script still matches its baseline (pristine, refresh pending)', async () => {
    const old = sha('#!/bin/sh\nold\n');
    expect(await stateFor({ updater_sha: old, updater_baseline_sha: old })).toBe('stale');
  });

  it('reads modified when the script diverges from its own baseline — the one state a human must fix', async () => {
    expect(
      await stateFor({
        updater_sha: sha('#!/bin/sh\nhand-edited\n'),
        updater_baseline_sha: sha('#!/bin/sh\nold\n'),
      }),
    ).toBe('modified');
  });

  it('reads unknown on a pre-v0.206 sidecar, which reports no script sha at all', async () => {
    expect(await stateFor({})).toBe('unknown');
  });
});

/**
 * The front door joined the release-owned set in v0.232.126. Same classify()
 * as compose, so the interesting cases are the field's ABSENCE (an older
 * updater) and a hand-edited Caddyfile, the exact thing that used to be
 * invisible.
 */
describe('readComposeStatus: Caddyfile state', () => {
  const CANONICAL =
    '{$MANTLE_SITE_ADDRESS::80} {\n\timport /etc/caddy/shapes/same-origin.caddy\n}\n';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  let dir: string;

  async function caddyFor(fields: Record<string, string>) {
    writeFileSync(
      join(dir, 'stack.json'),
      JSON.stringify({ compose_sha: '', baseline_sha: '', ...fields }),
    );
    vi.resetModules();
    const { readComposeStatus } = await import('./updates');
    return (await readComposeStatus()).caddy;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mantle-updates-caddy-'));
    writeFileSync(join(dir, 'Caddyfile'), CANONICAL);
    vi.stubEnv('MANTLE_UPDATE_SIGNAL_DIR', dir);
    vi.stubEnv('MANTLE_RELEASE_CADDYFILE_PATH', join(dir, 'Caddyfile'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is unknown when an older updater reports no caddy fields', async () => {
    expect(await caddyFor({})).toEqual({ state: 'unknown', refresh: null });
  });

  it("reads in-sync when the box Caddyfile is this release's", async () => {
    expect(
      await caddyFor({
        caddy_sha: sha(CANONICAL),
        caddy_baseline_sha: sha(CANONICAL),
        caddy_refresh: 'current',
      }),
    ).toEqual({ state: 'in-sync', refresh: 'current' });
  });

  it('reads modified when the box Caddyfile was hand-edited', async () => {
    expect(
      await caddyFor({
        caddy_sha: sha('hand edit'),
        caddy_baseline_sha: sha('old release'),
        caddy_refresh: 'modified',
      }),
    ).toEqual({ state: 'modified', refresh: 'modified' });
  });

  it('reads stale when the box still carries the previous release', async () => {
    expect(
      await caddyFor({ caddy_sha: sha('old release'), caddy_baseline_sha: sha('old release') }),
    ).toEqual({ state: 'stale', refresh: null });
  });
});

describe('readComposeStatus: operator-scripts state', () => {
  const NAMES = [
    'db-dump.sh',
    'db-restore.sh',
    'install.sh',
    'sanity.sh',
    'compose-adopt.sh',
    'uninstall.sh',
  ];
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  /** The set fingerprint, exactly as the updater's scripts_sha_of builds it. */
  const setSha = (body: (n: string) => string | null) =>
    sha(
      NAMES.map((n) => {
        const b = body(n);
        return `${n}:${b === null ? '' : sha(b)}\n`;
      }).join(''),
    );
  const release = (n: string) => `#!/bin/sh\n# ${n} v2\n`;
  let dir: string;

  async function scriptsFor(fields: Record<string, string>) {
    writeFileSync(
      join(dir, 'stack.json'),
      JSON.stringify({ compose_sha: '', baseline_sha: '', ...fields }),
    );
    vi.resetModules();
    const { readComposeStatus } = await import('./updates');
    return (await readComposeStatus()).scripts;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mantle-updates-scripts-'));
    mkdirSync(join(dir, 'release-scripts'), { recursive: true });
    for (const n of NAMES) writeFileSync(join(dir, 'release-scripts', n), release(n));
    vi.stubEnv('MANTLE_UPDATE_SIGNAL_DIR', dir);
    vi.stubEnv('MANTLE_RELEASE_SCRIPTS_DIR', join(dir, 'release-scripts'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is unknown when an older updater reports no scripts fields', async () => {
    expect(await scriptsFor({})).toEqual({ state: 'unknown', refresh: null });
  });

  it("reads in-sync when the box carries this release's scripts", async () => {
    const s = setSha(release);
    expect(
      await scriptsFor({ scripts_sha: s, scripts_baseline_sha: s, scripts_refresh: 'current' }),
    ).toEqual({ state: 'in-sync', refresh: 'current' });
  });

  it("dev's real shape: scripts present, ZERO baselines — stale, not modified", async () => {
    // The v0.232.140 regression, reproduced from the live box. The updater
    // hashed six 'name:' lines with empty values whenever no .release file
    // existed, which is a valid non-empty digest — so the reader's
    // "baseline exists?" test passed and the box reported 'modified',
    // demanding a human for something refresh_scripts fixes by itself.
    // scripts_sha_of now returns EMPTY when not one file in the set exists.
    expect(
      await scriptsFor({
        scripts_sha: setSha((n) => `#!/bin/sh\n# ${n} v1\n`),
        scripts_baseline_sha: '', // <- what an un-adopted box must now report
      }),
    ).toEqual({ state: 'stale', refresh: null });
  });

  it('reads stale with NO baseline — the refresh adopts it, no human needed', async () => {
    // This is the jason-prod state that started all of this: a box that never
    // adopted, running a compose-adopt.sh three releases behind. It must not
    // read as something an operator has to go and fix by hand.
    const old = setSha((n) => `#!/bin/sh\n# ${n} v1\n`);
    expect(await scriptsFor({ scripts_sha: old, scripts_baseline_sha: '' })).toEqual({
      state: 'stale',
      refresh: null,
    });
  });

  it('reads modified when a baseline exists and the box copy disagrees', async () => {
    expect(
      await scriptsFor({
        scripts_sha: setSha((n) => `#!/bin/sh\n# ${n} HAND EDIT\n`),
        scripts_baseline_sha: setSha((n) => `#!/bin/sh\n# ${n} v1\n`),
        scripts_refresh: 'modified',
      }),
    ).toEqual({ state: 'modified', refresh: 'modified' });
  });

  it('a MISSING script is visible in the digest, not silently dropped', async () => {
    const complete = setSha(release);
    const missingOne = setSha((n) => (n === 'sanity.sh' ? null : release(n)));
    expect(missingOne).not.toBe(complete);
  });
});

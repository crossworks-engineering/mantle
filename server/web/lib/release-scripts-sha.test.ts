import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The operator-scripts fingerprint is computed TWICE: by the updater in POSIX
 * sh (`scripts_sha_of`, writing stack.json) and by the web app in TypeScript
 * (`scriptsCanonicalSha`, hashing /app/release/scripts). The two are then
 * COMPARED to decide whether a box has drifted — so if they disagree by a
 * newline, every box on earth reads as drifted forever and the row becomes
 * noise everyone learns to ignore.
 *
 * Two implementations of one hash is the risk. Rather than assert a golden
 * string that both could be wrong about, this runs the REAL shell function
 * lifted out of updater.sh against a fixture and checks the TypeScript agrees.
 */
const ROOT = join(__dirname, '..', '..', '..');
const NAMES = [
  'db-dump.sh',
  'db-restore.sh',
  'install.sh',
  'sanity.sh',
  'compose-adopt.sh',
  'uninstall.sh',
];

/** Extract `sha_of` + `scripts_sha_of` from updater.sh and run them for real. */
function shellSha(dir: string): string {
  const updater = readFileSync(join(ROOT, 'infra/updater/updater.sh'), 'utf8');
  const shaOf = updater.match(/^sha_of\(\) \{.*$/m);
  const scriptsSha = updater.match(/^scripts_sha_of\(\) \{\n(?:.*\n)*?\}$/m);
  expect(shaOf, 'sha_of not found in updater.sh').toBeTruthy();
  expect(scriptsSha, 'scripts_sha_of not found in updater.sh').toBeTruthy();
  const script = [
    `STACK='${dir}'`,
    `SCRIPTS_REL=.`,
    `SCRIPT_NAMES='${NAMES.join(' ')}'`,
    shaOf![0],
    scriptsSha![0],
    'scripts_sha_of ""',
  ].join('\n');
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
}

/** The web app's algorithm, mirrored here so the test needs no server boot. */
async function tsSha(dir: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const lines = NAMES.map((n) => {
    try {
      return `${n}:${createHash('sha256')
        .update(readFileSync(join(dir, n)))
        .digest('hex')}`;
    } catch {
      return `${n}:`;
    }
  });
  return createHash('sha256')
    .update(lines.map((l) => `${l}\n`).join(''))
    .digest('hex');
}

describe('operator-scripts fingerprint: shell and TypeScript agree', () => {
  it('matches for a complete set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      for (const n of NAMES) writeFileSync(join(dir, n), `#!/bin/sh\necho ${n}\n`);
      expect(await tsSha(dir)).toBe(shellSha(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches when a script is MISSING — the empty-line case', async () => {
    // A bare `sha_of` prints NOTHING for an absent file, so an untagged
    // digest would drop the entry and a half-installed box could hash
    // identical to a complete one. Both sides emit 'name:' instead.
    const dir = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      for (const n of NAMES.slice(0, 3)) writeFileSync(join(dir, n), `#!/bin/sh\necho ${n}\n`);
      expect(await tsSha(dir)).toBe(shellSha(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes when any one script changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      for (const n of NAMES) writeFileSync(join(dir, n), `#!/bin/sh\necho ${n}\n`);
      const before = await tsSha(dir);
      writeFileSync(join(dir, 'compose-adopt.sh'), '#!/bin/sh\necho STALE\n');
      const after = await tsSha(dir);
      expect(after).not.toBe(before);
      expect(after).toBe(shellSha(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the TS name list matches the shell one', () => {
    const updater = readFileSync(join(ROOT, 'infra/updater/updater.sh'), 'utf8');
    const line = updater.match(/^SCRIPT_NAMES='([^']+)'/m);
    expect(line![1]!.split(/\s+/).filter(Boolean)).toEqual(NAMES);
    const app = readFileSync(join(ROOT, 'server/web/lib/updates.ts'), 'utf8');
    for (const n of NAMES)
      expect(app, `${n} missing from RELEASE_SCRIPT_NAMES`).toContain(`'${n}'`);
  });
});

describe('an absent SET hashes to empty, not to a hash of blanks', () => {
  /**
   * The distinction the drift row is built on: an EMPTY baseline digest means
   * "never adopted — refresh_scripts installs it unaided, nobody act", while a
   * non-empty one that disagrees means "somebody hand-edited a script".
   *
   * Shipped in v0.232.140 without this: six `name:` lines with empty hashes
   * still produce a perfectly valid digest, so dev — which has ZERO
   * scripts/*.release — reported 'modified' and demanded attention it did not
   * need. Caught on the live box within the hour, fixed here.
   */
  it('shell prints nothing when not one file in the set exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      expect(shellSha(dir)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one present file is enough to produce a digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      writeFileSync(join(dir, 'sanity.sh'), '#!/bin/sh\necho hi\n');
      const sha = shellSha(dir);
      expect(sha).not.toBe('');
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent set and a complete set never collide', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    const full = mkdtempSync(join(tmpdir(), 'mantle-scripts-'));
    try {
      for (const n of NAMES) writeFileSync(join(full, n), `#!/bin/sh\necho ${n}\n`);
      expect(shellSha(empty)).not.toBe(shellSha(full));
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(full, { recursive: true, force: true });
    }
  });
});

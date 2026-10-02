/**
 * Release-order guard for the first-run setup code (headless onboarding
 * audit, item 1).
 *
 * scripts/install.sh writes MANTLE_SETUP_CODE on every install, and signup
 * then refuses without it. A fresh install runs the owner UI pinned by
 * client-pair.tag, so that pin MUST be a jackdaw release that has the Setup
 * code field on its signup screen. Otherwise the brain answers "Enter the
 * setup code the installer printed" to a screen with nowhere to type it, and
 * nobody can sign up.
 *
 * So the order is: jackdaw ships the field first; then the SAME mantle release
 * that carries the setup code sets FIRST_CLIENT_WITH_SETUP_CODE_FIELD below to
 * that jackdaw tag and bumps client-pair.tag to it (or later). Until both are
 * done this test fails, and with it `pnpm verify` and the pre-push gate, so
 * the setup code cannot reach main ahead of its UI by accident.
 *
 * A test, not a runtime switch: the setup code is a security gate, and making
 * it depend on which UI version asks would let any caller opt out of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The first jackdaw release whose signup shows the Setup code field
 *  (jackdaw feat/headless-onboarding: client/web/app/login/setup-code-field.tsx).
 *  null until that release exists: set it when bumping client-pair.tag. */
const FIRST_CLIENT_WITH_SETUP_CODE_FIELD: string | null = 'v0.6.214';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function parse(tag: string): number[] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) throw new Error(`not a release tag: ${JSON.stringify(tag)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function atLeast(tag: string, min: string): boolean {
  const [a, b] = [parse(tag), parse(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

describe('the paired owner UI can enter the setup code', () => {
  const installerWritesCode = /^ensure MANTLE_SETUP_CODE /m.test(read('scripts/install.sh'));

  it('client-pair.tag is a jackdaw release with the Setup code field', () => {
    if (!installerWritesCode) return; // no setup code installed, nothing to pair
    const pinned = read('client-pair.tag').trim();
    expect(
      FIRST_CLIENT_WITH_SETUP_CODE_FIELD,
      'The installer writes MANTLE_SETUP_CODE, but no jackdaw release with the Setup code field ' +
        'is named yet. Release jackdaw first, then in THIS mantle release set ' +
        'FIRST_CLIENT_WITH_SETUP_CODE_FIELD (server/web/lib/client-pair-setup-code.test.ts) to ' +
        `that tag and bump client-pair.tag (now ${pinned}) to it or later.`,
    ).not.toBeNull();
    expect(
      atLeast(pinned, FIRST_CLIENT_WITH_SETUP_CODE_FIELD!),
      `client-pair.tag is ${pinned}, older than ${FIRST_CLIENT_WITH_SETUP_CODE_FIELD}, the first ` +
        'jackdaw release with the Setup code field: a fresh install could not sign up.',
    ).toBe(true);
  });

  it('the version compare itself', () => {
    expect(atLeast('v0.6.214', 'v0.6.214')).toBe(true);
    expect(atLeast('v0.6.215', '0.6.214')).toBe(true);
    expect(atLeast('v0.7.0', 'v0.6.214')).toBe(true);
    expect(atLeast('v0.6.213', 'v0.6.214')).toBe(false);
    expect(atLeast('v0.6.99', 'v0.6.214')).toBe(false);
    expect(() => parse('latest')).toThrow(/not a release tag/);
  });
});

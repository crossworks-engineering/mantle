/**
 * The setup code: proof that whoever claims a fresh brain is the person who
 * installed it.
 *
 * While auth.users is empty, POST /api/auth/signup makes its caller the owner.
 * A native caller (curl) sends no Origin and no Sec-Fetch-Site, so the
 * cross-site guard passes it, and a box on a public domain would belong to
 * whoever got there first. scripts/install.sh generates MANTLE_SETUP_CODE into
 * .env (never rotated) and prints it; signup asks for it until the first
 * account exists. Unset (local dev, tests, a box installed before the code
 * existed) means no code is asked for, the behaviour before it.
 *
 * Only the web service receives the variable, and only these booleans and the
 * compare ever touch it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

/** Trim, uppercase, and drop the dashes and spaces people type or paste. */
export function normalizeSetupCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

/** The configured code, normalized; null when none is set. */
function configuredSetupCode(): string | null {
  const code = normalizeSetupCode(env('MANTLE_SETUP_CODE') ?? '');
  return code ? code : null;
}

/** Does this brain gate first-run signup behind a setup code? */
export function setupCodeConfigured(): boolean {
  return configuredSetupCode() !== null;
}

/**
 * Does `given` match the configured code? Both sides are normalized and
 * hashed to the same length first, so the compare is timing-safe whatever
 * the caller sent. False when no code is configured: a caller that asks
 * should have checked setupCodeConfigured() first.
 */
export function setupCodeMatches(given: string | null | undefined): boolean {
  const expected = configuredSetupCode();
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(normalizeSetupCode(given)).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The read of company sign-in's setup row (docs/oidc-sign-in.md): the issuer
 * and the client id a Control Center staged in sso_setup (0371), and the mode
 * it raised (0372). Each process that reads the sign-in settings (web, the
 * agent runtime and every worker: a Telegram chat's check) awaits bootOidcRow
 * once before it serves, and re-reads the row every 60 seconds while the .env
 * has no mode line (watchOidcRow), so the settings read (@mantle/config
 * readOidcSettings) stays synchronous. One small select, no new connection.
 *
 * Two checks at boot:
 *  1. No read unless it is needed (oidcRowNeeded): the .env mode line is off,
 *     or it is on and the .env holds both names (a .env line wins), so a box
 *     set up by hand reads nothing.
 *  2. Required must be able to work after the read (oidcRequiredProblem): a
 *     required box whose settings read as off would let every password in,
 *     so the boot stops, as assertEnvShape stops one with a .env line
 *     missing.
 * A read that fails after the retries stops the boot when the mode may be
 * required: the .env says required, or the .env has no mode line (the row
 * may say required). Fail closed. With a .env line of setup or optional it
 * logs and goes on (optional reading off keeps passwords, as a half-set box
 * always did).
 *
 * A re-read that fails keeps what the process read last: the row's mode only
 * goes up, so the process reads the lower mode until a re-read answers. A
 * re-read in required runs check 2 too, and a process that fails it stops
 * (the caller's `stop`), as it would at boot.
 */
import {
  oidcModeInEnv,
  oidcModeWord,
  oidcRequiredProblem,
  oidcRowNeeded,
  setOidcRow,
  type OidcModeWord,
} from '@mantle/config';
import { errorMessage, withRetry } from '@mantle/std';
import { runAsSystem } from './actor';
import { db } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import { ssoSetup } from './schema/oidc-signin';

const BOOT_ATTEMPTS = 6;
const BOOT_RETRY_MS = 10_000;

/** How often a process re-reads the row while the .env has no mode line. */
export const OIDC_ROW_REREAD_MS = 60_000;

/** Read the row's names and mode into this process's settings (when
 *  needed). */
export async function loadOidcRow(): Promise<void> {
  if (!oidcRowNeeded()) return;
  const [row] = await runAsSystem('boot:oidc-row', () =>
    onFullSystemRoute('oidc-link', async () =>
      db
        .select({ issuer: ssoSetup.issuer, clientId: ssoSetup.clientId, mode: ssoSetup.mode })
        .from(ssoSetup)
        .limit(1),
    ),
  );
  setOidcRow(row ?? {});
}

/** Throw when the mode word is required and required cannot work (check 2). */
function holdRequired(): void {
  if (oidcModeWord() !== 'required') return;
  const problem = oidcRequiredProblem();
  if (problem) {
    throw new Error(`company sign-in is required but cannot work: ${problem}`);
  }
}

/** The boot step: the read with retries, then the required check. Throws
 *  to stop the boot. `warn` logs a line. `delayMs` for tests. */
export async function bootOidcRow(
  warn: (text: string) => void,
  delayMs = BOOT_RETRY_MS,
): Promise<void> {
  // The .env says required, or the row may (no .env mode line).
  const mayBeRequired = !oidcModeInEnv() || oidcModeWord() === 'required';
  try {
    await withRetry(() => loadOidcRow(), {
      retries: BOOT_ATTEMPTS - 1,
      retryOn: () => true,
      delayMs: () => delayMs,
      onRetry: ({ retry, failure }) =>
        warn(
          `company sign-in: the setup row could not be read (retry ${retry}): ${'error' in failure ? errorMessage(failure.error) : ''}`,
        ),
    });
  } catch (err) {
    if (mayBeRequired) throw err;
    warn(`company sign-in: the setup row could not be read: ${errorMessage(err)}`);
    return;
  }
  holdRequired();
}

/**
 * One re-read: the mode word before and after. A failed read keeps the last
 * one (logged). Throws when the word is required and required cannot work
 * (check 2, no read: the process stops). No read while the .env has a mode
 * line.
 */
export async function rereadOidcRow(
  warn: (text: string) => void,
): Promise<{ before: OidcModeWord; after: OidcModeWord }> {
  const before = oidcModeWord();
  if (oidcModeInEnv()) return { before, after: before };
  try {
    await loadOidcRow();
  } catch (err) {
    warn(`company sign-in: the setup row could not be read again: ${errorMessage(err)}`);
  }
  const after = oidcModeWord();
  holdRequired();
  return { before, after };
}

/**
 * Re-read the row every 60 seconds while the .env has no mode line (none
 * with one: the .env rules, and the row is never read). `tick` is the
 * process's re-read: rereadOidcRow, or web's, which runs the boot step's
 * work on a change. `stop` ends the process when a re-read into required
 * finds it cannot work. Returns the stop of the timer.
 */
export function watchOidcRow(
  tick: () => Promise<unknown>,
  stop: (err: unknown) => void,
  everyMs = OIDC_ROW_REREAD_MS,
): () => void {
  if (oidcModeInEnv()) return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch(stop)
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

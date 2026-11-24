/**
 * The read of company sign-in's setup row (docs/oidc-sign-in.md): the issuer
 * and the client id a Control Center staged in sso_setup (0371), the mode it
 * raised (0372), and the button's label (0399). Each process that reads the
 * sign-in settings (web, the agent runtime and every worker: a Telegram chat's
 * check) awaits bootOidcRow once before it serves, and re-reads the row every
 * 60 seconds unless the .env says off (watchOidcRow), so the settings read
 * (@mantle/config readOidcSettings) stays synchronous. One small select, no
 * new connection.
 *
 * Two checks at boot:
 *  1. No read unless it is needed (oidcRowNeeded): a .env mode line of off
 *     reads nothing. A read for the label alone (the .env holds the mode and
 *     both names, oidcRowDecides false) that fails logs and goes on.
 *  2. Required must be able to work after the read (oidcRequiredProblem): a
 *     required box whose settings read as off would let every password in,
 *     so the boot stops, as assertEnvShape stops one with a .env line
 *     missing.
 * A read that fails after the retries stops the boot when the mode may be
 * required and the row decides a value: the .env has no mode line (the row
 * may say required), or the .env says required and lacks a name. Fail closed. With a .env line of setup or optional it
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
  oidcRowDecides,
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

/** How often a process re-reads the row (unless the .env says off). */
export const OIDC_ROW_REREAD_MS = 60_000;

/** Read the row's names, label and mode into this process's settings (when
 *  needed). */
export async function loadOidcRow(): Promise<void> {
  if (!oidcRowNeeded()) return;
  const [row] = await runAsSystem('boot:oidc-row', () =>
    onFullSystemRoute('oidc-link', async () =>
      db
        .select({
          issuer: ssoSetup.issuer,
          clientId: ssoSetup.clientId,
          label: ssoSetup.label,
          mode: ssoSetup.mode,
        })
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
  // The row may say required (no .env mode line), or the .env says required
  // and the row holds a name it needs. A read for the label alone stops
  // nothing.
  const mayBeRequired = !oidcModeInEnv() || (oidcModeWord() === 'required' && oidcRowDecides());
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
 * (check 2, no read: the process stops). No read while the .env says off.
 */
export async function rereadOidcRow(
  warn: (text: string) => void,
): Promise<{ before: OidcModeWord; after: OidcModeWord }> {
  const before = oidcModeWord();
  if (!oidcRowNeeded()) return { before, after: before };
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
 * Re-read the row every 60 seconds unless the .env says off (then the row is
 * never read). With a .env mode line only the names it lacks and the label
 * can change: the .env mode wins. `tick` is the
 * process's re-read: rereadOidcRow, or web's, which runs the boot step's
 * work on a change. `stop` ends the process when a re-read into required
 * finds it cannot work. Returns the stop of the timer.
 */
export function watchOidcRow(
  tick: () => Promise<unknown>,
  stop: (err: unknown) => void,
  everyMs = OIDC_ROW_REREAD_MS,
): () => void {
  if (!oidcRowNeeded()) return () => {};
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

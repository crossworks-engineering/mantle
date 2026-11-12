/**
 * The boot read of company sign-in's row names (docs/oidc-sign-in.md): the
 * issuer and the client id a Control Center staged in sso_setup (0371). Each
 * process that reads the sign-in settings (web, the agent runtime and every
 * worker: a Telegram chat's check) awaits bootOidcRowNames once before it serves, so the
 * settings read (@mantle/config readOidcSettings) stays synchronous after it.
 *
 * Two checks:
 *  1. No read unless it is needed: the mode word is off, or the .env holds
 *     both names (a .env line wins), so a box set up by hand reads nothing.
 *  2. Required mode must be on after the read: a required box whose
 *     settings read as off would let every password in, so the boot stops,
 *     as assertEnvShape stops one with a .env line missing.
 * A read that fails after the retries stops a required boot too; any other
 * mode logs it and goes on (optional reading off keeps passwords, as a
 * half-set box always did).
 */
import {
  oidcModeWord,
  oidcRowNamesNeeded,
  readOidcSettings,
  setOidcRowNames,
} from '@mantle/config';
import { errorMessage, withRetry } from '@mantle/std';
import { runAsSystem } from './actor';
import { db } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import { ssoSetup } from './schema/oidc-signin';

const BOOT_ATTEMPTS = 6;
const BOOT_RETRY_MS = 10_000;

/** Read the row names into this process's settings (when needed). */
export async function loadOidcRowNames(): Promise<void> {
  if (!oidcRowNamesNeeded()) return;
  const [row] = await runAsSystem('boot:oidc-row', () =>
    onFullSystemRoute('oidc-link', async () =>
      db.select({ issuer: ssoSetup.issuer, clientId: ssoSetup.clientId }).from(ssoSetup).limit(1),
    ),
  );
  setOidcRowNames(row ?? {});
}

/** The boot step: the read with retries, then the required check. Throws
 *  to stop the boot. `warn` logs a line. `delayMs` for tests. */
export async function bootOidcRowNames(
  warn: (text: string) => void,
  delayMs = BOOT_RETRY_MS,
): Promise<void> {
  const required = oidcModeWord() === 'required';
  try {
    await withRetry(() => loadOidcRowNames(), {
      retries: BOOT_ATTEMPTS - 1,
      retryOn: () => true,
      delayMs: () => delayMs,
      onRetry: ({ retry, failure }) =>
        warn(
          `company sign-in: the setup row could not be read (retry ${retry}): ${'error' in failure ? errorMessage(failure.error) : ''}`,
        ),
    });
  } catch (err) {
    if (required) throw err;
    warn(`company sign-in: the setup row could not be read: ${errorMessage(err)}`);
    return;
  }
  if (!required) return;
  const { settings, problem } = readOidcSettings();
  if (settings.mode === 'off') {
    throw new Error(
      `MANTLE_OIDC_MODE is required but company sign-in cannot work: ${problem?.text ?? 'a value is missing'}`,
    );
  }
}

/**
 * Company sign-in settings (OIDC, docs/oidc-sign-in.md): what the box .env
 * says, read at each call (as `env` is), and the one answer every route and
 * gate asks, `oidcSettings()`.
 *
 * Off is the default and the hard rule (corporate plan section 2.1): with
 * MANTLE_OIDC_MODE empty or off, nothing here reads the database or calls a
 * provider, and every caller does what it did before this module existed.
 * A mode that is on but cannot work (no issuer, no client id, no
 * MANTLE_PUBLIC_URL for the redirect) is off too, logged once: a half-set
 * box keeps its passwords, never strands a login.
 */
import { readOidcSettings, type OidcOn, type OidcSettings } from '@mantle/config';

// The settings themselves are read in @mantle/config (oidc.ts), so the
// agent runtime's Telegram check reads the same answer as the gate.
export {
  DEFAULT_OIDC_LABEL,
  OIDC_CALLBACK_PATH,
  issuerKey,
  oidcLabel,
  type OidcOn,
  type OidcSettings,
} from '@mantle/config';

const warned = new Set<string>();
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // Loaded here: the session reads these settings on every request, and
  // its import graph stays free of the tracing store.
  void import('@mantle/tracing').then(({ log }) => log('auth').warn(text));
}

/**
 * The company sign-in settings now (@mantle/config readOidcSettings).
 * `{ mode: 'off' }` when the mode is blank or off, or when it is on but
 * incomplete (logged once per cause).
 */
export function oidcSettings(): OidcSettings {
  const { settings, problem } = readOidcSettings();
  if (problem) warnOnce(problem.key, problem.text);
  return settings;
}

/** Whether company sign-in is on (optional or required) now. */
export function oidcOn(s: OidcSettings = oidcSettings()): s is OidcOn {
  return s.mode !== 'off';
}

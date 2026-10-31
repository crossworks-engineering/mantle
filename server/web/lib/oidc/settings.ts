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
import { env, envFlag, envNum, parseOidcMode, type OidcMode } from '@mantle/config';

/** The label a site shows on its button when it sets none. */
export const DEFAULT_OIDC_LABEL = 'Single sign-on';

/** The path of the callback, under MANTLE_PUBLIC_URL: the redirect URI an
 *  operator registers with the provider. */
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

/** Company sign-in when it is on: every value the flow needs. */
export type OidcOn = Readonly<{
  mode: Exclude<OidcMode, 'off'>;
  /** The provider's issuer, as the .env names it (its discovery document
   *  must name the same; a link is keyed on it). */
  issuer: string;
  clientId: string;
  /** Null: a public client (PKCE only). */
  clientSecret: string | null;
  label: string;
  /** The life of a session company sign-in makes, in seconds. */
  sessionSeconds: number;
  /** MANTLE_PUBLIC_URL + OIDC_CALLBACK_PATH. */
  redirectUri: string;
  /** MANTLE_OIDC_OUTSIDE (on unless the operator turns it off, plan
   *  decision D3: outside client logins keep their passwords): an admin's
   *  outside mark keeps a login's password in required mode. Off: marks are
   *  refused and not honoured. */
  outsideAllowed: boolean;
}>;

export type OidcSettings = Readonly<{ mode: 'off' }> | OidcOn;

const OFF: OidcSettings = Object.freeze({ mode: 'off' });

const warned = new Set<string>();
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // Loaded here: the session reads these settings on every request, and
  // its import graph stays free of the tracing store.
  void import('@mantle/tracing').then(({ log }) => log('auth').warn(text));
}

/** The label from MANTLE_OIDC_LABEL: trimmed, one line, at most 60
 *  characters; the default when blank. */
export function oidcLabel(raw: string | undefined): string {
  const v = (raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 60);
  return v || DEFAULT_OIDC_LABEL;
}

/**
 * The company sign-in settings now. `{ mode: 'off' }` when the mode is
 * blank or off, or when it is on but incomplete (logged once per cause).
 * An unknown mode word is refused at boot (assertEnvShape); read here it is
 * off.
 */
export function oidcSettings(): OidcSettings {
  const mode = parseOidcMode(env('MANTLE_OIDC_MODE')) ?? 'off';
  if (mode === 'off') return OFF;
  const issuer = (env('MANTLE_OIDC_ISSUER') ?? '').trim();
  const clientId = (env('MANTLE_OIDC_CLIENT_ID') ?? '').trim();
  const publicUrl = (env('MANTLE_PUBLIC_URL') ?? '').trim();
  const missing = [
    issuer ? null : 'MANTLE_OIDC_ISSUER',
    clientId ? null : 'MANTLE_OIDC_CLIENT_ID',
    publicUrl ? null : 'MANTLE_PUBLIC_URL',
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    warnOnce(
      `missing:${missing.join(',')}`,
      `company sign-in is off: MANTLE_OIDC_MODE=${mode} but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set; passwords work as before`,
    );
    return OFF;
  }
  let redirectUri: string;
  try {
    redirectUri = new URL(OIDC_CALLBACK_PATH, publicUrl).toString();
    new URL(issuer);
  } catch {
    warnOnce(
      'bad-url',
      'company sign-in is off: MANTLE_OIDC_ISSUER or MANTLE_PUBLIC_URL is not a URL',
    );
    return OFF;
  }
  const secret = env('MANTLE_OIDC_CLIENT_SECRET') ?? '';
  return Object.freeze({
    mode,
    issuer,
    clientId,
    clientSecret: secret === '' ? null : secret,
    label: oidcLabel(env('MANTLE_OIDC_LABEL')),
    sessionSeconds: envNum('MANTLE_OIDC_SESSION_HOURS') * 3600,
    redirectUri,
    outsideAllowed: envFlag('MANTLE_OIDC_OUTSIDE', true),
  });
}

/** The issuer as a link stores it: the .env value with one trailing slash
 *  dropped (a provider's discovery document may write it either way). */
export function issuerKey(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

/** Whether company sign-in is on (optional or required) now. */
export function oidcOn(s: OidcSettings = oidcSettings()): s is OidcOn {
  return s.mode !== 'off';
}

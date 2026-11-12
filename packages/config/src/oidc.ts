/**
 * Company sign-in settings (OIDC, docs/oidc-sign-in.md) as the .env says
 * them, and the one rule of the password hold under company sign-in. Here,
 * not in server/web, so every process that finds a login reads the same
 * answer: the web gate and MCP (server/web lib/oidc), and a Telegram chat
 * (@mantle/telegram chat-login.ts), which the agent runtime asks in its own
 * process.
 *
 * Off is the default and the hard rule (corporate plan section 2.1): with
 * MANTLE_OIDC_MODE empty, off or setup nothing here reads more than the .env
 * and the row names below. The secret may live in the setup row instead:
 * only server/web lib/oidc provider.ts reads that.
 *
 * The issuer and the client id may come from the setup row (sso_setup, 0371:
 * a Control Center stages them while the mode word is setup,
 * docs/oidc-sign-in.md). Each process that reads the settings (web, the
 * agent runtime and the workers, for a Telegram chat) reads the row once at boot
 * (@mantle/db loadOidcRowNames, which calls setOidcRowNames), so the read
 * here stays synchronous. A .env line wins over the row, value by value. A mode that is on but cannot work (no issuer, no client id, no
 * MANTLE_PUBLIC_URL for the redirect) is off too: a half-set box keeps its
 * passwords, never strands a login. server/web lib/oidc/settings.ts logs
 * that once.
 */
import { env, envFlag, oidcModeWord, parseOidcMode, type OidcMode } from './index';
import { envNum } from './numbers';

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
  /** MANTLE_OIDC_CLIENT_SECRET. Null: none in the .env, so the setup row's,
   *  or a public client (PKCE only), server/web lib/oidc/provider.ts. */
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

/** The issuer and client id of the setup row, as this process read them at
 *  boot (blank: none). */
let rowNames: Readonly<{ issuer: string; clientId: string }> = { issuer: '', clientId: '' };

/** Set the row names this process uses: once at boot, and by the web
 *  process again when a Control Center stages new ones. */
export function setOidcRowNames(names: { issuer?: string | null; clientId?: string | null }): void {
  rowNames = Object.freeze({
    issuer: (names.issuer ?? '').trim(),
    clientId: (names.clientId ?? '').trim(),
  });
}

/** Where a name comes from: the box .env, the setup row, or neither. */
export type OidcNameSource = 'env' | 'row' | 'none';

/** The issuer and the client id in use, each with its source. A .env line
 *  wins over the row. */
export function oidcNames(): {
  issuer: string;
  clientId: string;
  issuerFrom: OidcNameSource;
  clientIdFrom: OidcNameSource;
} {
  const envIssuer = (env('MANTLE_OIDC_ISSUER') ?? '').trim();
  const envClient = (env('MANTLE_OIDC_CLIENT_ID') ?? '').trim();
  const from = (e: string, r: string): OidcNameSource => (e ? 'env' : r ? 'row' : 'none');
  return {
    issuer: envIssuer || rowNames.issuer,
    clientId: envClient || rowNames.clientId,
    issuerFrom: from(envIssuer, rowNames.issuer),
    clientIdFrom: from(envClient, rowNames.clientId),
  };
}

/** Whether a process must read the setup row's names at boot: the mode word
 *  is not off and the .env lacks the issuer or the client id. */
export function oidcRowNamesNeeded(): boolean {
  if (oidcModeWord() === 'off') return false;
  return (
    (env('MANTLE_OIDC_ISSUER') ?? '').trim() === '' ||
    (env('MANTLE_OIDC_CLIENT_ID') ?? '').trim() === ''
  );
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
 * The company sign-in settings now, and why an on mode is off (`problem`:
 * a key to log it once by, and the text). `{ mode: 'off' }` when the mode
 * is blank, off or setup, or on but incomplete. An unknown mode word is
 * refused at boot (assertEnvShape); read here it is off.
 */
export function readOidcSettings(): {
  settings: OidcSettings;
  problem: { key: string; text: string } | null;
} {
  return oidcSettingsFor(parseOidcMode(env('MANTLE_OIDC_MODE')) ?? 'off');
}

/** The settings as `mode` would read them: readOidcSettings with the live
 *  word, and the setup screen with `optional`, to see what the lock will
 *  apply. */
export function oidcSettingsFor(mode: OidcMode): {
  settings: OidcSettings;
  problem: { key: string; text: string } | null;
} {
  if (mode === 'off') return { settings: OFF, problem: null };
  const { issuer, clientId } = oidcNames();
  const publicUrl = (env('MANTLE_PUBLIC_URL') ?? '').trim();
  const missing = [
    issuer ? null : 'MANTLE_OIDC_ISSUER',
    clientId ? null : 'MANTLE_OIDC_CLIENT_ID',
    publicUrl ? null : 'MANTLE_PUBLIC_URL',
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    return {
      settings: OFF,
      problem: {
        key: `missing:${missing.join(',')}`,
        text: `company sign-in is off: MANTLE_OIDC_MODE=${mode} but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set; passwords work as before`,
      },
    };
  }
  let redirectUri: string;
  try {
    redirectUri = new URL(OIDC_CALLBACK_PATH, publicUrl).toString();
    new URL(issuer);
  } catch {
    return {
      settings: OFF,
      problem: {
        key: 'bad-url',
        text: 'company sign-in is off: MANTLE_OIDC_ISSUER or MANTLE_PUBLIC_URL is not a URL',
      },
    };
  }
  const secret = env('MANTLE_OIDC_CLIENT_SECRET') ?? '';
  return {
    settings: Object.freeze({
      mode,
      issuer,
      clientId,
      clientSecret: secret === '' ? null : secret,
      label: oidcLabel(env('MANTLE_OIDC_LABEL')),
      sessionSeconds: envNum('MANTLE_OIDC_SESSION_HOURS') * 3600,
      redirectUri,
      outsideAllowed: envFlag('MANTLE_OIDC_OUTSIDE', true),
    }),
    problem: null,
  };
}

/** The issuer as a link stores it: the .env value with one trailing slash
 *  dropped (a provider's discovery document may write it either way). */
export function issuerKey(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

/** Whether a login's password is a way in now: always, but in required
 *  mode, where a login linked to the provider signs in with it only (the
 *  original account keeps its password). The 'sso-required' answer of the
 *  sign-in rule (server/web lib/oidc/hold.ts ruleOf) is this, false. */
export function passwordIsWayIn(mode: OidcMode, f: { owner: boolean; linked: boolean }): boolean {
  return mode !== 'required' || f.owner || !f.linked;
}

/**
 * How a credential came, for the password hold:
 *  - 'password': a password sign-in's session (a cookie without company
 *    sign-in's mark, a device bearer);
 *  - 'sso': a cookie company sign-in made;
 *  - 'grant': what a session made (an API key, an MCP grant, a paired
 *    Telegram chat), which does not record the kind of the session that
 *    made it.
 */
export type CredentialKind = 'password' | 'sso' | 'grant';

/** A login's password hold (policy.ts passwordHoldState), or none. */
export type PasswordHold = 'change' | 'recheck' | null;

/**
 * The password hold (policy.ts passwordHoldState) that applies to a
 * credential of `kind` (docs/policy.md, docs/oidc-sign-in.md). Pure: the
 * whole table. The hold is about the login's password, so:
 *  - where the password is no way in (`passwordWayIn` false: required mode,
 *    a linked login), nothing: SSO logins are outside the rule;
 *  - 'change' holds every credential to the change step while the password
 *    is a way in (any session reaches the step; the change needs the
 *    password, which the person has);
 *  - 'recheck' is cleared only by a password sign-in: it holds a password
 *    session, never an SSO session (signing in with the company account
 *    again would meet the same answer), and a grant only of a login with no
 *    company way in (`companyWayIn`: linked while company sign-in is on),
 *    since a linked login's grant may have been made in an SSO session.
 *    Nobody is held to a step they cannot take (plan section 17.1 rule 4).
 */
export function passwordHoldFor(
  hold: PasswordHold,
  kind: CredentialKind,
  f: { passwordWayIn: boolean; companyWayIn: boolean },
): PasswordHold {
  if (hold === null || !f.passwordWayIn) return null;
  if (hold === 'change') return 'change';
  if (kind === 'password') return 'recheck';
  if (kind === 'sso') return null;
  return f.companyWayIn ? null : 'recheck';
}

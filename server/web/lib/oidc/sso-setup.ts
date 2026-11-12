/**
 * The setup screen of company sign-in and SCIM (docs/oidc-sign-in.md): what
 * its routes answer. The mode stays in the box .env, and so does the lock
 * (MANTLE_OIDC_MODE). The issuer and the client id are .env lines, or values
 * a Control Center staged in the setup row (ssoSetFromCenter; a .env line
 * wins). The screen takes only the client secret, sealed and never shown,
 * and makes the SCIM token, shown once with its hash kept.
 *
 * The Control Center's three sign-in cases (control/sso-channel.ts) answer
 * ssoCenterStatus, ssoSetupTest and ssoSetFromCenter.
 *
 * With the mode word off nothing here runs: the routes answer before it.
 * The SCIM step is a Control Center's only (owner decision B): elsewhere the
 * status says `scim: 'not-cc'` and SCIM's code is not loaded.
 */
import * as client from 'openid-client';
import { env, OIDC_CALLBACK_PATH, oidcModeWord, oidcNames, oidcSettingsFor } from '@mantle/config';
import type { SsoSetupStatusDTO, SsoSetupTestOutcome } from '@mantle/client-types';
import { seal } from '@mantle/crypto';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { loadOidcRowNames, SSO_SECRET_AAD, type ControlSsoStatus } from '@mantle/db';
import { isControlCenter } from '@/lib/control/env';
import { entraIssuer, issuerTenant } from './entra';
import { forgetProviderConfig, issuerKey, oidcClientSecret, providerConfig } from './provider';
import { activeLoginsWithLinks, oidcLoginRow, saveSsoStaged, ssoSetupRow } from './store';

/** Whether the box .env holds a client secret: it then wins over the row. */
export function envSecretSet(): boolean {
  return (env('MANTLE_OIDC_CLIENT_SECRET') ?? '') !== '';
}

/** Whether MANTLE_SCIM_TOKEN_HASH holds any value, `off` too: it then wins. */
export function envScimTokenSet(): boolean {
  return (env('MANTLE_SCIM_TOKEN_HASH') ?? '').trim() !== '';
}

/** The redirect URI to register, or '' when MANTLE_PUBLIC_URL is not a URL.
 *  Built here, not read from the settings, which are off with a line missing. */
function redirectUri(): string {
  try {
    return new URL(OIDC_CALLBACK_PATH, (env('MANTLE_PUBLIC_URL') ?? '').trim()).toString();
  } catch {
    return '';
  }
}

async function setter(
  id: string | null,
  at: Date | null,
): Promise<{ by: string | null; at: string } | null> {
  if (!at) return null;
  return { by: id ? ((await oidcLoginRow(id))?.email ?? null) : null, at: at.toISOString() };
}

/** What the screen shows, while the mode word is not off. Never a value of the
 *  secret, the hash or the token. */
export async function ssoSetupStatus(): Promise<SsoSetupStatusDTO> {
  const mode = oidcModeWord();
  if (mode === 'off') return { mode };
  const { issuer, clientId, issuerFrom, clientIdFrom } = oidcNames();
  const publicUrl = (env('MANTLE_PUBLIC_URL') ?? '').trim();
  const row = await ssoSetupRow();
  const scim = await scimStatus(publicUrl, row?.scimTokenHash ?? '');
  return {
    mode,
    issuer,
    clientId,
    issuerFrom,
    clientIdFrom,
    redirectUri: redirectUri(),
    scimUrl: scim.url,
    envMissing: missingNames(issuer, clientId, publicUrl),
    secret: envSecretSet() ? 'env' : row?.secretEnc ? 'row' : 'none',
    scim: scim.source,
    secretSet: await setter(row?.secretSetBy ?? null, row?.secretSetAt ?? null),
    scimSet:
      scim.source === 'not-cc'
        ? null
        : await setter(row?.scimSetBy ?? null, row?.scimSetAt ?? null),
  };
}

/** The names a sign-in still needs. The issuer and the client id may come
 *  from the setup row too (a .env line wins). */
function missingNames(issuer: string, clientId: string, publicUrl: string): string[] {
  return [
    issuer ? null : 'MANTLE_OIDC_ISSUER',
    clientId ? null : 'MANTLE_OIDC_CLIENT_ID',
    publicUrl ? null : 'MANTLE_PUBLIC_URL',
  ].filter((x): x is string => x !== null);
}

/** The SCIM step of the status: `not-cc` off a Control Center, with no SCIM
 *  code loaded; else where the token's hash comes from. */
async function scimStatus(
  publicUrl: string,
  rowHash: string,
): Promise<{ url: string; source: 'env' | 'env-off' | 'row' | 'none' | 'not-cc' }> {
  if (!isControlCenter()) return { url: '', source: 'not-cc' };
  const [{ scimBase }, { HASH_RE }] = await Promise.all([
    import('@/lib/scim/service'),
    import('@/lib/scim/settings'),
  ]);
  const rawHash = (env('MANTLE_SCIM_TOKEN_HASH') ?? '').trim();
  return {
    url: publicUrl ? scimBase() : '',
    source: HASH_RE.test(rawHash)
      ? 'env'
      : rawHash !== ''
        ? 'env-off'
        : HASH_RE.test(rowHash)
          ? 'row'
          : 'none',
  };
}

/** What a failure of discovery means. No secret was sent yet, so a status on
 *  the error says nothing about the secret. */
export function discoveryFailure(err: unknown): SsoSetupTestOutcome {
  return (err as { code?: unknown } | null)?.code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED'
    ? 'issuer-mismatch'
    : 'unreachable';
}

/** What a failure of the token call means. An error with a status or the
 *  provider's error word: the provider answered. Anything else: it did not.
 *  Not keyed on the error's type: a network failure may differ between Node
 *  and Bun. */
export function tokenFailure(err: unknown): SsoSetupTestOutcome {
  const e = err as { status?: unknown; error?: unknown; cause?: { status?: unknown } } | null;
  const status = e?.status ?? e?.cause?.status;
  if (e?.error === 'invalid_client' || status === 401) return 'secret-refused';
  return typeof status === 'number' || typeof e?.error === 'string' ? 'unclear' : 'unreachable';
}

/** The issuer in the provider's document is the one the .env names (a real
 *  sign-in's check, provider.ts). The library skips its own on Entra's host. */
export function issuerAgrees(documentIssuer: string, envIssuer: string): boolean {
  return issuerKey(documentIssuer) === issuerKey(envIssuer);
}

/**
 * One Test: the provider's document, its issuer, and a client credentials
 * grant with the client id and secret the lock will use. One fixed code, never
 * provider text. The token is thrown away. A pass does not prove a sign-in:
 * the redirect URI and the assignment of people show only at a real one.
 * `secretToTry`: a new secret, tested before it is saved (ssoSetFromCenter);
 * else the saved one.
 */
export async function ssoSetupTest(secretToTry?: string): Promise<SsoSetupTestOutcome> {
  const { settings: s } = oidcSettingsFor('optional');
  if (s.mode === 'off') return 'env-missing';
  let secret: string | null;
  try {
    secret = secretToTry ?? (await oidcClientSecret(s));
  } catch {
    return 'secret-unreadable';
  }
  if (!secret) return 'no-secret';
  forgetProviderConfig();
  let config: client.Configuration;
  try {
    config = await providerConfig(s, secret);
  } catch (err) {
    return discoveryFailure(err);
  }
  if (!issuerAgrees(config.serverMetadata().issuer, s.issuer)) return 'issuer-mismatch';
  try {
    await client.clientCredentialsGrant(
      config,
      issuerTenant(s.issuer) ? { scope: `${s.clientId}/.default` } : {},
    );
    return 'ok';
  } catch (err) {
    return tokenFailure(err);
  }
}

// --- the Control Center's sign-in cases ---------------------------------------

/**
 * The status a Control Center sees (control/sso-channel.ts sso_status):
 * where each value comes from, never a value of the secret, and two numbers.
 * With the mode word off: the mode alone, with no read.
 */
export async function ssoCenterStatus(): Promise<ControlSsoStatus> {
  const mode = oidcModeWord();
  const blank: ControlSsoStatus = {
    mode,
    tenant: null,
    issuer: '',
    issuerFrom: 'none',
    clientId: '',
    clientIdFrom: 'none',
    secret: 'none',
    secretSetAt: null,
    redirectUri: '',
    missing: [],
    linked: null,
    active: null,
  };
  if (mode === 'off') return blank;
  const n = oidcNames();
  const row = await ssoSetupRow();
  const logins = n.issuer ? await activeLoginsWithLinks(issuerKey(n.issuer)) : null;
  return {
    ...blank,
    tenant: issuerTenant(n.issuer),
    issuer: n.issuer,
    issuerFrom: n.issuerFrom,
    clientId: n.clientId,
    clientIdFrom: n.clientIdFrom,
    secret: envSecretSet() ? 'env' : row?.secretEnc ? 'row' : 'none',
    secretSetAt: envSecretSet() ? null : (row?.secretSetAt?.toISOString() ?? null),
    redirectUri: redirectUri(),
    missing: missingNames(n.issuer, n.clientId, (env('MANTLE_PUBLIC_URL') ?? '').trim()),
    linked: logins ? logins.filter((l) => l.linked).length : null,
    active: logins ? logins.length : null,
  };
}

/** What a Control Center may stage: an Entra tenant and client id (GUIDs,
 *  lower case) and the client secret. */
export type SsoStaged = { tenant?: string; clientId?: string; secret?: string };

/** The answer of a save from the Control Center. `mode`: the mode word is
 *  off, or names were sent while it is not setup. `env-wins`: the box .env
 *  holds that value. `test`: in an on mode the Test with the new secret did
 *  not answer ok (`test` names its code), and nothing was saved. */
export type SsoSetAnswer = {
  ok: boolean;
  reason?: 'mode' | 'env-wins' | 'test';
  test?: SsoSetupTestOutcome;
  /** A stored secret was cleared: the tenant or client changed without one. */
  secretCleared?: true;
};

/**
 * A save from the Control Center (sso_set). Two checks:
 *  1. The lock: the tenant and the client id only while the mode word is
 *     setup (sign-in off), the secret in any mode but off; a value the box
 *     .env holds is refused (it wins).
 *  2. In optional or required the new secret is saved only when the Test with
 *     it answers ok, so a wrong paste never breaks sign-in.
 * The secret is sealed with this box's master key; the row's names are read
 * again here, so this process's status and Test see them at once (the other
 * processes read them at their next boot, which the go-live restart is).
 */
export async function ssoSetFromCenter(a: SsoStaged): Promise<SsoSetAnswer> {
  const mode = oidcModeWord();
  const names = a.tenant !== undefined || a.clientId !== undefined;
  if (mode === 'off' || (names && mode !== 'setup')) return { ok: false, reason: 'mode' };
  const envHas = (name: 'MANTLE_OIDC_ISSUER' | 'MANTLE_OIDC_CLIENT_ID') =>
    (env(name) ?? '').trim() !== '';
  if (
    (a.tenant !== undefined && envHas('MANTLE_OIDC_ISSUER')) ||
    (a.clientId !== undefined && envHas('MANTLE_OIDC_CLIENT_ID')) ||
    (a.secret !== undefined && envSecretSet())
  ) {
    return { ok: false, reason: 'env-wins' };
  }
  let test: SsoSetupTestOutcome | undefined;
  if (a.secret !== undefined && mode !== 'setup') {
    test = await ssoSetupTest(a.secret);
    if (test !== 'ok') return { ok: false, reason: 'test', test };
  }
  const r = await saveSsoStaged({
    ...(a.tenant !== undefined ? { issuer: entraIssuer(a.tenant) } : {}),
    ...(a.clientId !== undefined ? { clientId: a.clientId.toLowerCase() } : {}),
    ...(a.secret !== undefined ? { secretEnc: seal(a.secret, SSO_SECRET_AAD).ciphertext } : {}),
  });
  // A failed re-read does not undo the save: the status shows the row at the
  // next read, and the next boot reads it.
  if (names) {
    await loadOidcRowNames().catch((err) =>
      log('auth').warn(
        `company sign-in: the staged names could not be read back: ${errorMessage(err)}`,
      ),
    );
  }
  forgetProviderConfig();
  return {
    ok: true,
    ...(test ? { test } : {}),
    ...(r.secretCleared ? { secretCleared: true } : {}),
  };
}

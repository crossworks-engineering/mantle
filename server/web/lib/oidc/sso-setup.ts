/**
 * The setup screen of company sign-in and SCIM (docs/oidc-sign-in.md): what
 * its routes answer. The mode, the issuer and the client id stay in the box
 * .env, and so does the lock (MANTLE_OIDC_MODE). The screen takes only the
 * client secret, sealed and never shown, and makes the SCIM token, shown once
 * with its hash kept.
 *
 * With the mode word off nothing here runs: the routes answer before it.
 */
import * as client from 'openid-client';
import { env, OIDC_CALLBACK_PATH, oidcModeWord, oidcSettingsFor } from '@mantle/config';
import type { SsoSetupStatusDTO, SsoSetupTestOutcome } from '@mantle/client-types';
import { scimBase } from '@/lib/scim/service';
import { HASH_RE, issuerTenant } from '@/lib/scim/settings';
import { forgetProviderConfig, issuerKey, oidcClientSecret, providerConfig } from './provider';
import { oidcLoginRow, ssoSetupRow } from './store';

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
  const issuer = (env('MANTLE_OIDC_ISSUER') ?? '').trim();
  const clientId = (env('MANTLE_OIDC_CLIENT_ID') ?? '').trim();
  const publicUrl = (env('MANTLE_PUBLIC_URL') ?? '').trim();
  const row = await ssoSetupRow();
  const rawHash = (env('MANTLE_SCIM_TOKEN_HASH') ?? '').trim();
  return {
    mode,
    issuer,
    clientId,
    redirectUri: redirectUri(),
    scimUrl: publicUrl ? scimBase() : '',
    envMissing: [
      issuer ? null : 'MANTLE_OIDC_ISSUER',
      clientId ? null : 'MANTLE_OIDC_CLIENT_ID',
      publicUrl ? null : 'MANTLE_PUBLIC_URL',
    ].filter((x): x is string => x !== null),
    secret: envSecretSet() ? 'env' : row?.secretEnc ? 'row' : 'none',
    scim: HASH_RE.test(rawHash)
      ? 'env'
      : rawHash !== ''
        ? 'env-off'
        : HASH_RE.test(row?.scimTokenHash ?? '')
          ? 'row'
          : 'none',
    secretSet: await setter(row?.secretSetBy ?? null, row?.secretSetAt ?? null),
    scimSet: await setter(row?.scimSetBy ?? null, row?.scimSetAt ?? null),
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
 */
export async function ssoSetupTest(): Promise<SsoSetupTestOutcome> {
  const { settings: s } = oidcSettingsFor('optional');
  if (s.mode === 'off') return 'env-missing';
  let secret: string | null;
  try {
    secret = await oidcClientSecret(s);
  } catch {
    return 'secret-unreadable';
  }
  if (!secret) return 'no-secret';
  forgetProviderConfig();
  let config: client.Configuration;
  try {
    config = await providerConfig(s);
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

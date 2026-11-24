/**
 * The setup screen of company sign-in and SCIM (docs/oidc-sign-in.md): what
 * its routes answer. The mode stays in the box .env, and so does the lock
 * (MANTLE_OIDC_MODE). The issuer and the client id are .env lines, or values
 * a Control Center staged in the setup row (ssoSetFromCenter; a .env line
 * wins). The screen takes the client secret, sealed and never shown, and
 * the button's label (0399, any mode but off; MANTLE_OIDC_LABEL wins), and
 * makes the SCIM token, shown once with its hash kept.
 *
 * The Control Center's four sign-in cases (control/sso-channel.ts) answer
 * ssoCenterStatus, ssoSetupTest, ssoSetFromCenter and ssoModeFromCenter (the
 * one-way raise of the mode, 0372).
 *
 * With the mode word off nothing here runs: the routes answer before it.
 * The SCIM step is a Control Center's only (owner decision B): elsewhere the
 * status says `scim: 'not-cc'` and SCIM's code is not loaded.
 */
import * as client from 'openid-client';
import {
  env,
  OIDC_CALLBACK_PATH,
  oidcModeFrom,
  oidcModeInEnv,
  oidcModeStepUp,
  oidcModeWord,
  oidcLabelInEnv,
  oidcLabelInUse,
  oidcNames,
  oidcRequiredProblem,
  oidcSettingsFor,
} from '@mantle/config';
import type { SsoSetupStatusDTO, SsoSetupTestOutcome } from '@mantle/client-types';
import { ssoLabelValue } from '@mantle/client-types/sso-label';
import { seal } from '@mantle/crypto';
import { errorMessage, InputError } from '@mantle/std';
import { log } from '@mantle/tracing';
import { loadOidcRow, SSO_SECRET_AAD, type ControlSsoStatus } from '@mantle/db';
import { isControlCenter } from '@/lib/control/env';
import { entraIssuer, issuerTenant } from './entra';
import { forgetProviderConfig, issuerKey, oidcClientSecret, providerConfig } from './provider';
import { oidcApplyRow } from './boot';
import {
  activeLoginsWithLinks,
  oidcLoginRow,
  saveSsoMode,
  saveSsoStaged,
  ssoSetupRow,
} from './store';

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
    ...oidcLabelInUse(),
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
 * With the mode word off: the mode alone, with no read. `withLabel`: the
 * label and its source too (0399), only for a CC that asked for them (an
 * older CC refuses an answer with fields it does not know) and for a CC's
 * own box.
 */
export async function ssoCenterStatus(withLabel: boolean): Promise<ControlSsoStatus> {
  const mode = oidcModeWord();
  const blank: ControlSsoStatus = {
    mode,
    modeFrom: oidcModeFrom(),
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
    ...(withLabel ? oidcLabelInUse() : {}),
    secret: envSecretSet() ? 'env' : row?.secretEnc ? 'row' : 'none',
    secretSetAt: envSecretSet() ? null : (row?.secretSetAt?.toISOString() ?? null),
    redirectUri: redirectUri(),
    missing: missingNames(n.issuer, n.clientId, (env('MANTLE_PUBLIC_URL') ?? '').trim()),
    linked: logins ? logins.filter((l) => l.linked).length : null,
    active: logins ? logins.length : null,
  };
}

/** What a Control Center may stage: an Entra tenant and client id (GUIDs,
 *  lower case), the client secret, and the button's label (held to the
 *  pattern, @mantle/client-types sso-label.ts; '' clears it).
 *  `acceptUnclear`: a person confirmed a new secret whose Test answers
 *  `unclear` (not a value: it changes only that one refusal). */
export type SsoStaged = {
  tenant?: string;
  clientId?: string;
  secret?: string;
  label?: string;
  acceptUnclear?: true;
};

/** The answer of a save from the Control Center. `mode`: the mode word is
 *  off, or names were sent while it is not setup. `env-wins`: the box .env
 *  holds that value. `test`: in an on mode the Test with the new secret did
 *  not answer ok (`test` names its code), and nothing was saved; `unclear`
 *  may be saved on a second ask with `acceptUnclear`. */
export type SsoSetAnswer = {
  ok: boolean;
  reason?: 'mode' | 'env-wins' | 'test';
  test?: SsoSetupTestOutcome;
  /** The secret was saved on a Test that answered `unclear`, as the person
   *  confirmed (`acceptUnclear`). */
  acceptedUnclear?: true;
  /** A stored secret was cleared: the tenant or client changed without one. */
  secretCleared?: true;
};

/**
 * A save from the Control Center (sso_set). Two checks:
 *  1. The lock: the tenant and the client id only while the mode word is
 *     setup (sign-in off), the secret and the label in any mode but off; a
 *     value the box .env holds is refused (it wins).
 *  2. In optional or required the new secret is saved only when the Test with
 *     it answers ok, so a wrong paste never breaks sign-in. One code more
 *     when a person confirmed it (`acceptUnclear`): `unclear`, where the
 *     provider answered with another error and did not say the secret is
 *     wrong (Entra with Assignment required on Yes answers so for a good
 *     secret). `secret-refused` and every other code stay refused.
 * A save that cannot apply every value it carries applies none. The secret
 * is sealed with this box's master key; the row's names and label are read
 * again here, so this process's status and Test see them at once (the other
 * processes within 60 seconds, sso-row.ts watchOidcRow).
 */
export async function ssoSetFromCenter(a: SsoStaged): Promise<SsoSetAnswer> {
  // The lock reads the mode the row holds now, when the row holds it (no
  // .env mode line), not one a re-read has yet to bring.
  if (!oidcModeInEnv()) await loadOidcRow();
  const mode = oidcModeWord();
  const names = a.tenant !== undefined || a.clientId !== undefined;
  // The channel and the route hold it to the pattern first: this is the
  // last word, not a second rule.
  const label = a.label === undefined ? undefined : ssoLabelValue(a.label);
  if (label === false) throw new InputError('The label does not fit the pattern.');
  if (mode === 'off' || (names && mode !== 'setup')) return { ok: false, reason: 'mode' };
  const envHas = (name: 'MANTLE_OIDC_ISSUER' | 'MANTLE_OIDC_CLIENT_ID') =>
    (env(name) ?? '').trim() !== '';
  if (
    (a.tenant !== undefined && envHas('MANTLE_OIDC_ISSUER')) ||
    (a.clientId !== undefined && envHas('MANTLE_OIDC_CLIENT_ID')) ||
    (a.secret !== undefined && envSecretSet()) ||
    (label !== undefined && oidcLabelInEnv())
  ) {
    return { ok: false, reason: 'env-wins' };
  }
  let test: SsoSetupTestOutcome | undefined;
  if (a.secret !== undefined && mode !== 'setup') {
    test = await ssoSetupTest(a.secret);
    if (test !== 'ok' && !(test === 'unclear' && a.acceptUnclear === true)) {
      return { ok: false, reason: 'test', test };
    }
  }
  const r = await saveSsoStaged({
    ...(a.tenant !== undefined ? { issuer: entraIssuer(a.tenant) } : {}),
    ...(a.clientId !== undefined ? { clientId: a.clientId.toLowerCase() } : {}),
    ...(a.secret !== undefined ? { secretEnc: seal(a.secret, SSO_SECRET_AAD).ciphertext } : {}),
    ...(label !== undefined ? { label } : {}),
  });
  // A failed re-read does not undo the save: the status shows the row at the
  // next read, and the next boot reads it.
  if (names || label !== undefined) {
    await loadOidcRow().catch((err) =>
      log('auth').warn(
        `company sign-in: the staged values could not be read back: ${errorMessage(err)}`,
      ),
    );
  }
  forgetProviderConfig();
  return {
    ok: true,
    ...(test ? { test } : {}),
    ...(test === 'unclear' ? { acceptedUnclear: true } : {}),
    ...(r.secretCleared ? { secretCleared: true } : {}),
  };
}

/** What a Control Center may raise the mode to: one step at a time. */
export type SsoModeStep = 'setup' | 'optional' | 'required';

/** The answer of a raise from the Control Center. `env-wins`: the box .env
 *  holds a MANTLE_OIDC_MODE line. `mode`: not one step up from the mode the
 *  box runs now, or required while required could not work. `from`: the mode
 *  word before. */
export type SsoModeAnswer = {
  ok: boolean;
  reason?: 'env-wins' | 'mode';
  from?: string;
};

/**
 * A raise of the mode from the Control Center (sso_mode). Two checks:
 *  1. The box .env has no MANTLE_OIDC_MODE line (`off` included): a .env
 *     line always wins, so a person at the box can always turn it down or
 *     off there. Else `env-wins`.
 *  2. `to` is exactly one step above the mode the box runs now (the row,
 *     read fresh, and still the same under its lock when written): off to
 *     setup, setup to optional, and optional to required only while required
 *     can work (oidcRequiredProblem: the settings read on, the .env shape of
 *     required), so the box never boots into a stop. Else `mode`.
 * Then web applies it at once (boot.ts oidcApplyRow: the boot step for the
 * new word, so a raise into required ends the sessions the rule refuses,
 * once); the other processes read it within 60 seconds.
 */
export async function ssoModeFromCenter(to: SsoModeStep): Promise<SsoModeAnswer> {
  if (oidcModeInEnv()) return { ok: false, reason: 'env-wins' };
  await loadOidcRow();
  const from = oidcModeWord();
  if (
    !oidcModeStepUp(from, to) ||
    (to === 'required' && oidcRequiredProblem() !== null) ||
    !(await saveSsoMode(from, to))
  ) {
    return { ok: false, reason: 'mode', from };
  }
  // This process reads the new mode at once, even while a boot step is still
  // queued; the queued apply then runs the boot step for it.
  await loadOidcRow().catch(() => {});
  // A failed apply keeps the raise: the next re-read (60 seconds) applies it.
  await oidcApplyRow().catch((err) =>
    log('auth').warn(
      `company sign-in: the raised mode could not be applied yet: ${errorMessage(err)}`,
    ),
  );
  return { ok: true, from };
}

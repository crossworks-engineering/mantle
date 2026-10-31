/**
 * The provider half of company sign-in (docs/oidc-sign-in.md): the one
 * place Mantle talks to an OIDC provider, through openid-client. The
 * provider is read from its discovery document; nothing here knows a
 * vendor. Authorization code with PKCE (S256), state and nonce; the ID
 * token's signature (against the provider's published keys), issuer, aud
 * claim, expiry and nonce are checked by the library.
 *
 * Only called while company sign-in is on (settings.ts oidcSettings): with
 * the mode off no route reaches here, so the box calls no provider.
 *
 * The issuer is the operator's .env value, not outside input, so the calls
 * use the platform fetch (not the egress guard of docs/egress.md, which
 * refuses private addresses: an on-premises provider is a normal setup).
 * Plain http is refused, except to a loopback host (a provider in a test).
 */
import * as client from 'openid-client';
import { TtlCache } from '@mantle/std';
import { issuerKey, type OidcOn } from './settings';

/** How long a discovered provider is kept before it is read again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Clock skew allowed between this box and the provider, seconds. */
const AUTH_TIME_SKEW_SECONDS = 60;
let warnedNoAuthTime = false;

/** Seconds each call to the provider may take. */
const PROVIDER_TIMEOUT_SECONDS = 10;

/** The discovered provider, one entry (its key: the issuer, client id and
 *  secret). A failure is not kept: the next call tries again. */
const discovered = new TtlCache<string, Promise<client.Configuration>>({
  ttlMs: DISCOVERY_TTL_MS,
  maxEntries: 1,
});

export { issuerKey };

/** A host a test provider may run on over plain http. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The provider's configuration, discovered once an hour. */
export function providerConfig(s: OidcOn): Promise<client.Configuration> {
  const key = `${s.issuer}\n${s.clientId}\n${s.clientSecret ?? ''}`;
  const hit = discovered.get(key);
  if (hit) return hit;
  const url = new URL(s.issuer);
  const insecure = url.protocol === 'http:';
  if (insecure && !isLoopbackHost(url.hostname)) {
    return Promise.reject(new Error('MANTLE_OIDC_ISSUER must use https'));
  }
  const auth = s.clientSecret ? client.ClientSecretPost(s.clientSecret) : client.None();
  // The ID token's signature is checked against the provider's published
  // keys (jwks_uri) too, not only its claims: the token endpoint's TLS is
  // not the only proof, and a loopback test provider has none.
  const config = client.discovery(url, s.clientId, undefined, auth, {
    timeout: PROVIDER_TIMEOUT_SECONDS,
    execute: insecure
      ? [client.allowInsecureRequests, client.enableNonRepudiationChecks]
      : [client.enableNonRepudiationChecks],
  });
  discovered.set(key, config);
  config.catch(() => {
    if (discovered.get(key) === config) discovered.delete(key);
  });
  return config;
}

/** Forget the discovered provider (tests). */
export function forgetProviderConfig(): void {
  discovered.clear();
}

/** The values one sign-in or link flow carries from its start to its
 *  callback (kept in the signed state cookie, cookies.ts). */
export type FlowSecrets = Readonly<{ state: string; nonce: string; codeVerifier: string }>;

/** Fresh state, nonce and PKCE verifier for one flow. */
export function newFlowSecrets(): FlowSecrets {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  };
}

/** The provider's sign-in URL for one flow. `link`: the person signs in at
 *  the provider again (prompt=login), so a link never takes whichever
 *  account the browser happens to be signed into. */
export async function authorizationUrl(
  s: OidcOn,
  f: FlowSecrets,
  opts: { link?: boolean } = {},
): Promise<string> {
  const config = await providerConfig(s);
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: s.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state: f.state,
    nonce: f.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(f.codeVerifier),
    code_challenge_method: 'S256',
    // A link must be a fresh sign-in at the provider, never the account the
    // browser is already in: both standard asks (a provider honours one).
    ...(opts.link ? { prompt: 'login', max_age: '0' } : {}),
  });
  return url.toString();
}

/** Who the provider says signed in: its issuer and subject (the link's
 *  key), and the tid and oid claims when it sends them (kept, never
 *  matched on). */
export type ProviderIdentity = Readonly<{
  issuer: string;
  subject: string;
  tid: string | null;
  oid: string | null;
  /** The account's email or user name as the provider shows it: for the
   *  audit trail only (who linked), never matched on. */
  display: string | null;
}>;

function shortClaim(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 ? v : null;
}

/**
 * Trade the callback's code for the ID token and answer who signed in.
 * `query` is the callback's own query string. The URL the library reads is
 * built on the registered redirect URI, never the request's host (behind a
 * proxy that is the container's address). Throws on any failure: a bad
 * state, a provider error, a token that does not verify.
 */
export async function identityFromCallback(
  s: OidcOn,
  query: URLSearchParams,
  f: FlowSecrets,
  opts: { linkStartedAt?: number } = {},
): Promise<ProviderIdentity> {
  const config = await providerConfig(s);
  const current = new URL(s.redirectUri);
  current.search = query.toString();
  const tokens = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: f.codeVerifier,
    expectedState: f.state,
    expectedNonce: f.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('the provider sent no ID token');
  // A link asked the provider for a fresh sign-in (prompt=login, max_age=0).
  // When the token says when the person signed in (auth_time), it must be
  // at or after the link's own start, so a provider that ignored the prompt
  // cannot hand over whichever account the browser was signed into. A
  // provider that sends no auth_time is let through (never strand anyone,
  // plan 17.1), said once in the log: the fresh sign-in is then asked, not
  // proven.
  if (opts.linkStartedAt !== undefined) {
    const at = claims.auth_time;
    if (typeof at === 'number') {
      if (at < opts.linkStartedAt - AUTH_TIME_SKEW_SECONDS) {
        throw new Error('the provider sign-in is older than the link');
      }
    } else if (!warnedNoAuthTime) {
      warnedNoAuthTime = true;
      // Loaded here: this module stays free of the tracing store.
      void import('@mantle/tracing').then(({ log }) =>
        log('auth').warn(
          'company sign-in: the provider sends no auth_time on a link; a fresh sign-in is asked (prompt=login), not proven',
        ),
      );
    }
  }
  // The library checks the token's issuer against the discovered one; the
  // discovered one must be the issuer the .env names, as every link is
  // keyed on it (issuerKey: one trailing slash is not a difference).
  const issuer = issuerKey(s.issuer);
  if (claims.iss !== config.serverMetadata().issuer || issuerKey(claims.iss) !== issuer) {
    throw new Error('the ID token issuer is not MANTLE_OIDC_ISSUER');
  }
  const subject = shortClaim(claims.sub);
  if (!subject) throw new Error('the ID token has no usable subject');
  const display =
    shortClaim(claims.email) ?? shortClaim(claims.preferred_username) ?? shortClaim(claims.upn);
  return {
    issuer,
    subject,
    tid: shortClaim(claims.tid),
    oid: shortClaim(claims.oid),
    display: display ? display.slice(0, 120) : null,
  };
}

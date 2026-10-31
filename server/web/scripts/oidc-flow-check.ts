/**
 * The company sign-in round trip against a real local OIDC provider
 * (docs/oidc-sign-in.md, "Testing"): discovery, the authorization URL (PKCE
 * S256, state, nonce), a real sign-in at the provider's own login form, the
 * code for the ID token, and the checks that must refuse (a wrong state, a
 * wrong nonce, a wrong PKCE verifier, a code used twice). Through the same
 * module the routes use (lib/oidc/provider.ts). No database.
 *
 * For a Keycloak on a loopback port (the test provider; never a production
 * tenant):
 *
 *   MANTLE_OIDC_MODE=optional MANTLE_OIDC_ISSUER=http://127.0.0.1:8180/realms/mantle-test \
 *   MANTLE_OIDC_CLIENT_ID=mantle MANTLE_OIDC_CLIENT_SECRET=<test secret> \
 *   MANTLE_PUBLIC_URL=http://127.0.0.1:3999 OIDC_CHECK_USER=<test user> \
 *   OIDC_CHECK_PASSWORD=<test password> pnpm -C server/web oidc:flow-check
 *
 * Prints one line per check and exits 1 on the first that fails. Prints no
 * token, code, secret or subject.
 */
import { env, envFlag } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { oidcSettings } from '../lib/oidc/settings';
import {
  authorizationUrl,
  identityFromCallback,
  isLoopbackHost,
  newFlowSecrets,
  type FlowSecrets,
} from '../lib/oidc/provider';

const user = env('OIDC_CHECK_USER') ?? '';
const password = env('OIDC_CHECK_PASSWORD') ?? '';

let failed = false;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

/** A tiny cookie jar: name to value, per sign-in. */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1));
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Sign in at the provider's own form as the test user and answer the
 *  callback's query (code, state, iss), as a browser would carry it back. */
async function signInAtProvider(authUrl: string, redirectUri: string): Promise<URLSearchParams> {
  const jar = new Jar();
  const page = await fetch(authUrl, { redirect: 'manual' });
  jar.take(page);
  const html = await page.text();
  const action = /<form[^>]*\baction="([^"]+)"/i.exec(html)?.[1];
  if (!action) throw new Error(`no login form at the provider (status ${page.status})`);
  const posted = await fetch(action.replace(/&amp;/g, '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username: user, password, credentialId: '' }),
  });
  const location = posted.headers.get('location');
  if (!location || !location.startsWith(redirectUri)) {
    throw new Error(`the provider did not send the browser back (status ${posted.status})`);
  }
  return new URL(location).searchParams;
}

async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const s = oidcSettings();
  if (s.mode === 'off') throw new Error('company sign-in is off: set the MANTLE_OIDC_* settings');
  if (!user || !password) throw new Error('set OIDC_CHECK_USER and OIDC_CHECK_PASSWORD');
  // The test user's password goes to the issuer's own form: a loopback test
  // provider only, unless asked (a provider's test tenant, never production).
  if (!isLoopbackHost(new URL(s.issuer).hostname) && !envFlag('OIDC_CHECK_REMOTE', false)) {
    throw new Error(
      'the issuer is not a loopback test provider: set OIDC_CHECK_REMOTE=on for a test tenant',
    );
  }

  const f = newFlowSecrets();
  const url = await authorizationUrl(s, f);
  const u = new URL(url);
  check('discovery read and an authorization URL built', u.href.startsWith(s.issuer));
  check('PKCE S256', u.searchParams.get('code_challenge_method') === 'S256');
  check(
    'state and nonce sent',
    u.searchParams.get('state') === f.state && u.searchParams.get('nonce') === f.nonce,
  );
  check('redirect URI is the callback', u.searchParams.get('redirect_uri') === s.redirectUri);

  const query = await signInAtProvider(url, s.redirectUri);
  check('the provider signed the test user in and sent a code back', query.has('code'));
  const identity = await identityFromCallback(s, query, f);
  check(
    'the ID token verified; issuer is MANTLE_OIDC_ISSUER',
    identity.issuer === s.issuer.replace(/\/$/, ''),
  );
  check('a subject came back', identity.subject.length > 0);
  check(
    'the same code a second time is refused',
    await refused(() => identityFromCallback(s, query, f)),
  );

  // Each check on a fresh sign-in, so only the one value differs.
  const wrong = async (change: (g: FlowSecrets) => FlowSecrets) => {
    const g = newFlowSecrets();
    const q = await signInAtProvider(await authorizationUrl(s, g), s.redirectUri);
    return refused(() => identityFromCallback(s, q, change(g)));
  };
  check('a wrong state is refused', await wrong((g) => ({ ...g, state: `${g.state}x` })));
  check('a wrong nonce is refused', await wrong((g) => ({ ...g, nonce: `${g.nonce}x` })));
  check(
    'a wrong PKCE verifier is refused',
    await wrong((g) => ({ ...g, codeVerifier: newFlowSecrets().codeVerifier })),
  );
  // A link flow asks the provider to sign in again, and completes.
  const lf = newFlowSecrets();
  const linkUrl = await authorizationUrl(s, lf, { link: true });
  check(
    'a link flow asks for a fresh sign-in (prompt=login)',
    new URL(linkUrl).searchParams.get('prompt') === 'login',
  );
  check(
    'a link flow asks for a fresh sign-in (max_age=0)',
    new URL(linkUrl).searchParams.get('max_age') === '0',
  );
  const linkQuery = await signInAtProvider(linkUrl, s.redirectUri);
  check(
    'the link flow signs in; its token verifies with a fresh auth_time',
    (
      await identityFromCallback(s, linkQuery, lf, {
        linkStartedAt: Math.floor(Date.now() / 1000) - 5,
      })
    ).subject === identity.subject,
  );
  // A callback that carries the provider's error, not a code.
  const denied = new URLSearchParams({ error: 'access_denied', state: f.state });
  check('a provider error is refused', await refused(() => identityFromCallback(s, denied, f)));
}

main()
  .catch((err: unknown) => {
    console.log(`FAIL ${errorMessage(err)}`);
    failed = true;
  })
  .finally(() => {
    console.log(failed ? 'oidc flow check: FAILED' : 'oidc flow check: all passed');
    process.exit(failed ? 1 : 0);
  });

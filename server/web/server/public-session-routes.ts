/**
 * The public routes that read a session themselves, for the role sweeps
 * (client logins audit A4). The sweeps drive every manifest route with a
 * signed cookie, but a route under PUBLIC_PATHS has no gate in front of it,
 * so the sweeps skipped them all, and with them every route that reads the
 * caller's session on its own (/api/auth, /api/oauth). The client refusals
 * in change-password and the MCP consent page were tested nowhere.
 *
 * Each such route is listed here with an explicit answer per role, and the
 * sweeps drive each one (role-sweep: client and unknown role; member-sweep:
 * member). A completeness test reads the source of every OTHER public route
 * and fails if it calls a session reader: a new public route that reads the
 * session must be added here, with its answers.
 *
 * The print and render pages (server/pages/print.ts) are mounted outside the
 * manifest; they are listed here as well.
 *
 * Test support only: nothing in the app imports this.
 */
import type { Hono } from 'hono';

export type SweepRole = 'member' | 'client' | 'unknown';

/** What a route must answer one role. */
export type Expected = {
  status: number;
  /** The JSON body's `reason`, when the answer is a role refusal. */
  reason?: string;
  /** The Location header must match (a redirect). */
  location?: RegExp;
};

export type PublicSessionRoute = {
  /** `METHOD /pattern`, as in the route manifest. */
  key: string;
  /** The request: the path (concrete) and anything else it needs. */
  path: string;
  init?: RequestInit;
  expect: Record<SweepRole, Expected>;
  /** Driven with the session cookie only. Every other route is ALSO driven
   *  with the role's device token (a bearer) and must answer the same: a
   *  bearer is a session of the same login. Set for the routes that take
   *  the bearer itself as their subject and read its row from the database
   *  (rotation, phone sign-out): their bearer behaviour is proven on
   *  Postgres (lib/auth/device-tokens.db.test.ts). */
  cookieOnly?: true;
};

const UUID = '11111111-1111-4111-8111-111111111111';

/** A registered MCP client for the consent page (lib/mcp-oauth is stood in
 *  by the sweeps so the page gets past its own checks to the login). */
export const SWEEP_OAUTH_CLIENT = {
  id: '99999999-9999-4999-8999-999999999999',
  redirectUri: 'https://mcp-client.example.invalid/callback',
};

const consentParams = new URLSearchParams({
  response_type: 'code',
  client_id: SWEEP_OAUTH_CLIENT.id,
  redirect_uri: SWEEP_OAUTH_CLIENT.redirectUri,
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
  state: 'sweep',
});

const refused = (reason: string): Expected => ({ status: 403, reason });
const stranger: Expected = { status: 401 };
const toLogin: Expected = { status: 307, location: /^(https?:\/\/[^/]+)?\/login/ };
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const PUBLIC_SESSION_ROUTES: PublicSessionRoute[] = [
  {
    // An admin or a member changes their own password; a client has none.
    // The empty body is a 400 only once past the role check.
    key: 'POST /api/auth/change-password',
    path: '/api/auth/change-password',
    init: json({}),
    expect: { member: { status: 400 }, client: refused('client-login'), unknown: stranger },
  },
  {
    // Who am I, for any credential: the role and the routes that differ per
    // role (the phone app, three roles). About the login only.
    key: 'GET /api/auth/whoami',
    path: '/api/auth/whoami',
    expect: { member: { status: 200 }, client: { status: 200 }, unknown: stranger },
  },
  {
    // Every role signs out; a client's sign-out also ends its sessions (audit
    // B23; the sweeps stand the epoch bump in). A stranger just gets a
    // cleared cookie.
    key: 'POST /api/auth/logout',
    path: '/api/auth/logout',
    init: json({}),
    expect: { member: { status: 200 }, client: { status: 200 }, unknown: { status: 200 } },
  },
  {
    // "Sign in on your phone" is for admins (the phone app is an admin app).
    key: 'POST /api/auth/pair',
    path: '/api/auth/pair',
    init: { method: 'POST' },
    expect: {
      member: refused('member-login'),
      client: refused('client-login'),
      unknown: stranger,
    },
  },
  {
    key: 'GET /api/auth/pair/:id',
    path: `/api/auth/pair/${UUID}`,
    expect: {
      member: refused('member-login'),
      client: refused('client-login'),
      unknown: stranger,
    },
  },
  {
    // The bearer to cookie upgrade: an admin's or a member's (the member's
    // cookie carries it to the MCP consent page). A client signs in to a
    // cookie already.
    key: 'POST /api/auth/sso',
    path: '/api/auth/sso',
    init: { method: 'POST' },
    expect: {
      member: { status: 204 },
      client: refused('client-login'),
      unknown: stranger,
    },
  },
  {
    // The MCP consent page: an HTML refusal to a member or a client, the
    // sign-in redirect to a stranger.
    key: 'GET /api/oauth/authorize',
    path: `/api/oauth/authorize?${consentParams}`,
    expect: { member: { status: 403 }, client: { status: 403 }, unknown: toLogin },
  },
  {
    // Allow/Deny: the same refusals; a stranger's session "expired".
    key: 'POST /api/oauth/authorize',
    path: '/api/oauth/authorize',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SWEEP_OAUTH_CLIENT.id,
        redirect_uri: SWEEP_OAUTH_CLIENT.redirectUri,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        consent_token: 'forged',
        decision: 'allow',
      }).toString(),
    },
    expect: { member: { status: 403 }, client: { status: 403 }, unknown: { status: 401 } },
  },
  {
    // Client sign-in with a link (C2). It reads no session, so a cookie of any
    // role buys nothing: a bad body is the same 401 for everyone.
    key: 'POST /api/auth/client-link',
    path: '/api/auth/client-link',
    init: json({}),
    expect: { member: { status: 401 }, client: { status: 401 }, unknown: { status: 401 } },
  },
  {
    // Email sign-in codes (C2b). None reads a session, so a cookie of any role
    // buys nothing: whether codes are on, the same 200 for every request
    // (queued, never an answer about the email), and the same 401 for a bad
    // verify.
    key: 'GET /api/auth/client-code',
    path: '/api/auth/client-code',
    expect: { member: { status: 200 }, client: { status: 200 }, unknown: { status: 200 } },
  },
  {
    key: 'POST /api/auth/client-code',
    path: '/api/auth/client-code',
    init: json({ email: 'someone@example.invalid' }),
    expect: { member: { status: 200 }, client: { status: 200 }, unknown: { status: 200 } },
  },
  {
    key: 'POST /api/auth/client-code/verify',
    path: '/api/auth/client-code/verify',
    init: json({}),
    expect: { member: { status: 401 }, client: { status: 401 }, unknown: { status: 401 } },
  },
  {
    // Bearer rotation: authenticates by the Authorization header only, so a
    // cookie of any role rotates nothing.
    key: 'POST /api/auth/token/refresh',
    path: '/api/auth/token/refresh',
    init: { method: 'POST' },
    expect: { member: { status: 401 }, client: { status: 401 }, unknown: { status: 401 } },
    cookieOnly: true,
  },
  {
    // The phone's sign-out: by the Authorization header only, always 200, so
    // a cookie of any role ends nothing.
    key: 'POST /api/auth/mobile-logout',
    path: '/api/auth/mobile-logout',
    init: { method: 'POST' },
    expect: { member: { status: 200 }, client: { status: 200 }, unknown: { status: 200 } },
    cookieOnly: true,
  },
  // The password token logins read no session: a cookie or a bearer of any
  // role buys nothing, and a bad body is the same 401 for everyone.
  ...(['mobile-login', 'token', 'device-login'] as const).map((name): PublicSessionRoute => ({
    key: `POST /api/auth/${name}`,
    path: `/api/auth/${name}`,
    init: json({}),
    expect: { member: { status: 401 }, client: { status: 401 }, unknown: { status: 401 } },
  })),
];

/** The render surfaces (server/pages/print.ts, outside the manifest): an
 *  admin session or a render cookie for that node, else the sign-in page. */
export const RENDER_PAGES: PublicSessionRoute[] = [
  '/print/pages/:id',
  '/print/draws/:id',
  '/render/draws/:id',
].map((pattern) => ({
  key: `GET ${pattern}`,
  path: pattern.replace(':id', UUID),
  expect: { member: toLogin, client: toLogin, unknown: toLogin },
}));

/** A call in a route's source that reads the caller's session or login. A
 *  public route whose source matches must be in PUBLIC_SESSION_ROUTES. */
export const SESSION_READER_RE =
  /\b(getLoginOr401|getOwnerOr401\w*|getSessionUser\w*|getMemberOr401|getClientOr401|resolveLogin|requireOwner\w*|handleOwnerSso|getOwnerForAsset|getMemberForAsset|getClientForAsset|renderCaller|verifyMobileToken|mobileTokenJti|handleTokenLogin)\b/;

let driven = 0;

/** Drive `route` with `auth` (a session cookie string, or headers: a
 *  bearer); the failure line, or null when it answered what `role` must get. */
export async function drivePublic(
  app: Hono,
  route: PublicSessionRoute,
  role: SweepRole,
  auth: string | Record<string, string>,
): Promise<string | null> {
  const init = route.init ?? {};
  const authHeaders = typeof auth === 'string' ? { cookie: auth } : auth;
  // A fresh address per call: the auth routes limit per address, and the
  // sweeps drive each of them many times (the limiters have their own tests).
  driven += 1;
  const res = await app.request(route.path, {
    ...init,
    method: init.method ?? 'GET',
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...authHeaders,
      'x-forwarded-for': `198.51.100.${driven % 250}`,
    },
  });
  const want = route.expect[role];
  const got: string[] = [];
  if (res.status !== want.status) got.push(`status ${res.status}, want ${want.status}`);
  if (want.reason !== undefined) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null;
    if (body?.reason !== want.reason) got.push(`reason ${body?.reason}, want ${want.reason}`);
  }
  if (want.location) {
    const to = res.headers.get('location') ?? '';
    if (!want.location.test(to)) got.push(`location ${to || '(none)'}`);
  }
  const how = typeof auth === 'string' ? 'cookie' : 'bearer';
  return got.length ? `${route.key} as ${role} (${how}): ${got.join('; ')}` : null;
}

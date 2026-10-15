/**
 * The route rate limits as main had them (A10 #8; docs/request-plumbing.md,
 * "Rate limits"): every limit a route took per request, by hand, in its own
 * file or in a helper its handler called first, with its bucket, the scope
 * its key names, its max and its window. The rate sweep
 * (a10-rate-sweep.test.ts) drives each through the full pipeline and holds
 * the answers to the ones recorded on main; after the move the limits are
 * rows of ROUTE_POLICY (lib/route-limits.ts), and the sweep checks the table
 * says the same as this list, limit by limit.
 *
 * Test support only: nothing in the app imports this.
 */

/** Whose key a limit counts: the caller's address (clientIpKey), the
 *  login the caller is, or the whole brain (a failure budget). */
export type SweepScope = 'ip' | 'login' | 'brain';

export type SweepLimit = Readonly<{
  /** The bucket's key prefix, as on main. */
  bucket: string;
  scope: SweepScope;
  max: number;
  windowMs: number;
  /** Only a member login counts (an Admin user is not limited). */
  members?: true;
  /** A failure budget (the brain-wide invite caps): looked at on the way
   *  in, counted by the handler on each failure. */
  peek?: true;
}>;

/** One limited row and how the sweep calls it: the credential, the query
 *  and the body. */
export type SweepCell = Readonly<{
  /** `METHOD pattern`, the ROUTE_POLICY row. */
  row: string;
  cred: 'none' | 'owner' | 'member';
  query?: string;
  body?: string;
  limits: readonly SweepLimit[];
  /** The handler refused a cross-site browser request before any limit
   *  (refuseCrossSiteAuthPost). */
  crossSite?: true;
  /** The rows that share this bucket: exhausted here, refused there. */
  sharesWith?: readonly string[];
  /** A request the handler refused before its limit on main (the user
   *  search's own checks): the probe's query. */
  earlyRefusal?: string;
  /** A query that takes no limit on main (the bytes routes' metadata). */
  freeQuery?: string;
}>;

const MIN = 60_000;
const HOUR = 60 * MIN;

const ip = (bucket: string, max: number, windowMs = MIN): SweepLimit => ({
  bucket,
  scope: 'ip',
  max,
  windowMs,
});
const login = (bucket: string, max: number, windowMs = MIN): SweepLimit => ({
  bucket,
  scope: 'login',
  max,
  windowMs,
});
const members = (bucket: string, max: number, windowMs = MIN): SweepLimit => ({
  ...login(bucket, max, windowMs),
  members: true,
});
const failures = (bucket: string, max: number): SweepLimit => ({
  bucket,
  scope: 'brain',
  max,
  windowMs: MIN,
  peek: true,
});

const JSON_BODY = '{}';
const TOKEN_LOGINS = [
  'POST /api/auth/token',
  'POST /api/auth/mobile-login',
  'POST /api/auth/device-login',
];
const ADMIN_PUSH = ['POST /api/push/connect', 'POST /api/push/subscriptions'];
const MEMBER_PUSH = ['POST /api/member/push/connect', 'POST /api/member/push/subscriptions'];
const others = (all: readonly string[], row: string) => all.filter((r) => r !== row);

/** A GET row and the HEAD its handler answers, with the same limits. */
const getHead = (pattern: string, cell: Omit<SweepCell, 'row'>): SweepCell[] => [
  { row: `GET ${pattern}`, ...cell },
  { row: `HEAD ${pattern}`, ...cell },
];

export const SWEEP_CELLS: readonly SweepCell[] = [
  // The sign-in routes, per address.
  {
    row: 'POST /api/auth/login',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:login', 10)],
    crossSite: true,
  },
  {
    row: 'POST /api/auth/signup',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:signup', 5)],
    crossSite: true,
  },
  {
    row: 'POST /api/auth/pair/claim',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:pair-claim', 10)],
  },
  {
    row: 'POST /api/auth/token/refresh',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:token-refresh', 30)],
  },
  ...TOKEN_LOGINS.map((row): SweepCell => ({
    row,
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:token-login', 10)],
    sharesWith: others(TOKEN_LOGINS, row),
  })),
  { row: 'POST /api/auth/sso', cred: 'none', limits: [ip('owner-sso:ip', 30)] },
  ...getHead('/api/auth/invite/:code', {
    cred: 'none',
    limits: [ip('auth:invite-preview', 30), failures('auth:invite-preview:failed', 600)],
  }),
  {
    row: 'POST /api/auth/invite/accept',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('auth:invite-accept', 10), failures('auth:invite-accept:failed', 120)],
    crossSite: true,
  },
  // The sign-in routes, per login (the login the public row reads).
  {
    row: 'POST /api/auth/pair',
    cred: 'owner',
    limits: [login('auth:pair-issue', 10)],
  },
  {
    row: 'POST /api/auth/change-password',
    cred: 'owner',
    body: JSON_BODY,
    limits: [login('auth:change-password', 5, HOUR)],
    crossSite: true,
  },
  // The remote MCP and its OAuth server, per address.
  ...['GET', 'POST', 'DELETE', 'HEAD'].map((m): SweepCell => ({
    row: `${m} /api/mcp`,
    cred: 'none',
    ...(m === 'POST' ? { body: JSON_BODY } : {}),
    limits: [ip('mcp', 300)],
  })),
  {
    row: 'POST /api/oauth/register',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('oauth:register', 10)],
  },
  { row: 'POST /api/oauth/token', cred: 'none', body: JSON_BODY, limits: [ip('oauth:token', 30)] },
  // Per login, after the caller's answer.
  {
    row: 'POST /api/telegram/pair',
    cred: 'owner',
    body: JSON_BODY,
    limits: [login('telegram-pair', 10)],
  },
  {
    row: 'POST /api/assistant/transcribe',
    cred: 'member',
    body: JSON_BODY,
    limits: [members('chat-transcribe', 6)],
  },
  {
    row: 'POST /api/users/:id/password',
    cred: 'owner',
    body: JSON_BODY,
    limits: [login('users:password-reset', 10, HOUR)],
  },
  ...ADMIN_PUSH.map((row): SweepCell => ({
    row,
    cred: 'owner',
    body: JSON_BODY,
    limits: [login('push-enrol', 10)],
    sharesWith: others(ADMIN_PUSH, row),
  })),
  ...MEMBER_PUSH.map((row): SweepCell => ({
    row,
    cred: 'member',
    body: JSON_BODY,
    limits: [login('push-enrol', 10)],
    sharesWith: others(MEMBER_PUSH, row),
  })),
  {
    row: 'POST /api/apps/:id/frame-ticket',
    cred: 'member',
    limits: [members('member-frame-ticket', 30)],
  },
  {
    row: 'POST /api/apps/:id/db-broker',
    cred: 'member',
    body: JSON_BODY,
    limits: [members('member-db-broker', 300)],
  },
  {
    row: 'POST /api/apps/:id/tool-broker',
    cred: 'member',
    body: JSON_BODY,
    limits: [members('member-tool-broker', 60)],
  },
  // A member's bytes: the file, or its thumbnail (a budget of its own).
  ...['/api/files/files/:id', '/api/v1/files/:id'].flatMap((p) => [
    ...getHead(p, {
      cred: 'member',
      query: '?raw=1',
      limits: [members('member-bytes', 240)],
      freeQuery: '',
    }),
    ...getHead(p, {
      cred: 'member',
      query: '?thumb=1',
      limits: [members('member-thumbs', 60)],
    }),
  ]),
  ...getHead('/api/v1/files/:id/download', {
    cred: 'member',
    limits: [members('member-bytes', 240)],
  }),
  ...getHead('/api/workspaces/user-search', {
    cred: 'owner',
    query: '?q=sweep',
    limits: [login('ws-user-search', 60)],
    earlyRefusal: '?q=sweep&offset=x',
  }),
  // The /s link routes, per address.
  ...getHead('/s/:token/aggregate', { cred: 'none', limits: [ip('share-aggregate', 120)] }),
  ...getHead('/s/:token/bundle', { cred: 'none', limits: [ip('share-bundle', 30)] }),
  {
    row: 'POST /s/:token/code',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('contact-code:ip', 10), ip('contact-code:ip-hour', 30, HOUR)],
    crossSite: true,
  },
  {
    row: 'POST /s/:token/db-broker',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('share-db-broker', 300)],
  },
  ...getHead('/s/:token/draw', { cred: 'none', limits: [ip('share-draw', 240)] }),
  ...getHead('/s/:token/draw/:drawId', { cred: 'none', limits: [ip('share-draw-embed', 240)] }),
  {
    row: 'POST /s/:token/evaluate',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('share-evaluate', 60)],
  },
  { row: 'POST /s/:token/frame-ticket', cred: 'none', limits: [ip('share-frame-ticket', 30)] },
  ...getHead('/s/:token/rows', { cred: 'none', limits: [ip('share-rows', 120)] }),
  {
    row: 'POST /s/:token/tool-broker',
    cred: 'none',
    body: JSON_BODY,
    limits: [ip('share-tool-broker', 60)],
  },
  ...getHead('/s/:token/view', { cred: 'none', limits: [ip('share-view', 120)] }),
  ...getHead('/s/:token/a/:fileId', { cred: 'none', limits: [ip('share-asset', 240)] }),
];

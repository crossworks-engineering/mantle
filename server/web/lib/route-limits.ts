/**
 * Rate limits on the ROUTE_POLICY row (A10 #8; docs/request-plumbing.md,
 * "Rate limits"). Before, 38 limits were taken by hand: each route (or a
 * helper its handler called first) built its own bucket key, named its own
 * max and window inline, and answered its own 429 (15 texts, a text body on
 * five routes, two header spellings, no Retry-After on two). A new route had
 * no limit unless someone remembered one.
 *
 * Now:
 *
 *  - RATE_LIMITS: every named limit, once: its bucket (the key prefix, as on
 *    main), whose key it counts (the caller's address, its login, or the
 *    whole brain), its max and its window, and the narrowings a limit had
 *    (members only; a query it applies to).
 *  - RouteGates: what the gate checks of a request before its handler, by
 *    row: the cross-site refusal (refuseCrossSiteAuthPost, which comes
 *    before any limit) and the named limits. Each route file's declaration
 *    states them (`limits`); buildRouteRow reads them into the row's
 *    `crossSite` and `rateLimit` (an /api/v1 alias takes its base route's,
 *    as it runs the base's handler).
 *  - takeRouteLimits: the gate takes a row's limits once the caller is
 *    answered (gate.ts), or, on a public row that reads its login at the
 *    read, when the handler reads it (session.ts publicLoginItself): where
 *    the handler took them before, so what came first still does.
 *  - rateLimitedResponse: the one 429. One body text, one header spelling,
 *    always Retry-After.
 *
 * The bucket store is lib/rate-limit.ts, unchanged: a fixed window per key,
 * in memory.
 */
import { NextResponse } from '../server/http-compat';
import { clientIpKey, rateLimit, rateLimitPeek, type RateLimitResult } from './rate-limit';
import { CACHE_CONTROL } from './cache-control';

/** Whose key a limit counts: the caller's address (clientIpKey, an IPv6
 *  caller by its /64), the login the caller is, or the whole brain (one
 *  bucket: a failure budget). */
export type RateLimitScope = 'ip' | 'login' | 'brain';

export type RateLimitSpec = Readonly<{
  /** The bucket's key prefix: the key is `bucket:<address or login id>`,
   *  or the bucket itself for the brain. As on main, byte for byte. */
  bucket: string;
  per: RateLimitScope;
  max: number;
  windowMs: number;
  /** Only a member login counts: an Admin user is not limited. */
  members?: true;
  /** Only a request whose query this says (the bytes routes: the bytes or
   *  the thumbnail, never the metadata). `says` is for the docs. */
  when?: Readonly<{ says: string; test: (query: URLSearchParams) => boolean }>;
  /** A failure budget: looked at on the way in (a 429 once it is spent),
   *  counted by the handler on each failure (countRateFailure). */
  peek?: true;
  /** A machine's limit (an OAuth client, an MCP client): its 429 keeps
   *  `error: 'rate_limited'`, the code those clients read (the machine
   *  shape of rateLimitedAnswer; A10 lows, #8 L1). */
  machine?: true;
  /** For an app's author: what the limit counts and how to stay under it.
   *  A 429 of this limit says it in `error` (with the wait), in place of
   *  the one text, so the app shows it (owner decision 2026-10-24). */
  explain?: string;
}>;

const MIN = 60_000;
const HOUR = 60 * MIN;

const perIp = (bucket: string, max: number, windowMs = MIN): RateLimitSpec => ({
  bucket,
  per: 'ip',
  max,
  windowMs,
});
const perLogin = (bucket: string, max: number, windowMs = MIN): RateLimitSpec => ({
  bucket,
  per: 'login',
  max,
  windowMs,
});
const perMember = (bucket: string, max: number, windowMs = MIN): RateLimitSpec => ({
  ...perLogin(bucket, max, windowMs),
  members: true,
});
/** A limit on an app's calls to the brain, per login, an Admin user's
 *  too: `what` it counts, `how` an app stays under it. */
const appLimit = (bucket: string, max: number, what: string, how: string): RateLimitSpec => ({
  ...perLogin(bucket, max),
  explain: `Too many requests: this app made more than ${max} ${what} in a minute for this login. ${how}`,
});
const failures = (bucket: string, max: number): RateLimitSpec => ({
  bucket,
  per: 'brain',
  max,
  windowMs: MIN,
  peek: true,
});

/** The bytes of a file (`?raw`, or a `?thumb` that is not 1), or its
 *  thumbnail (`?thumb=1`): each its own budget; the metadata none. */
const BYTES_ASKED = {
  says: 'the bytes are asked (?raw, or ?thumb other than 1)',
  test: (q: URLSearchParams) => (q.has('raw') || q.has('thumb')) && q.get('thumb') !== '1',
};
const THUMB_ASKED = {
  says: 'a thumbnail is asked (?thumb=1)',
  test: (q: URLSearchParams) => q.get('thumb') === '1',
};

/**
 * Every named limit. Sized for people, each with the reason it was given
 * where it was taken by hand: before bcrypt (the sign-ins), a code oracle
 * (pairing, invites, contact codes), a mint loop (tickets, pairing codes,
 * push enrolment), a query or a model call a stranger can trigger (the /s
 * brokers, the MCP, voice clips), a slow statement (the user search).
 */
export const RATE_LIMITS = {
  // Sign in, per address: before bcrypt, so a flood cannot pin the CPU.
  authLogin: perIp('auth:login', 10),
  authSignup: perIp('auth:signup', 5),
  authPairClaim: perIp('auth:pair-claim', 10),
  authTokenRefresh: perIp('auth:token-refresh', 30),
  /** One bucket for the three token sign-ins: alternating them buys
   *  nothing. */
  authTokenLogin: perIp('auth:token-login', 10),
  ownerSso: perIp('owner-sso:ip', 30),
  /** The invite routes are code oracles: every request counts per address,
   *  and the brain's failed codes count toward a cap of their own (a guard
   *  against a distributed flood: member-invites.ts). */
  invitePreview: perIp('auth:invite-preview', 30),
  invitePreviewFailures: failures('auth:invite-preview:failed', 600),
  inviteAccept: perIp('auth:invite-accept', 10),
  inviteAcceptFailures: failures('auth:invite-accept:failed', 120),
  // Sign in, per login (a public row's login, taken at the read).
  authPairIssue: perLogin('auth:pair-issue', 10),
  authChangePassword: perLogin('auth:change-password', 5, HOUR),
  // The remote MCP and its OAuth server, per address. Each MCP caller also
  // has a budget of its own, which the route takes once it has resolved
  // the bearer (app/api/mcp/route.ts, named in route-plumbing.mjs).
  mcp: { ...perIp('mcp', 300), machine: true },
  oauthRegister: { ...perIp('oauth:register', 10), machine: true },
  oauthToken: { ...perIp('oauth:token', 30), machine: true },
  // Per login, once the caller is answered.
  telegramPair: perLogin('telegram-pair', 10),
  /** A member's voice clips (an Admin user's are not limited). */
  chatTranscribe: perMember('chat-transcribe', 6),
  passwordReset: perLogin('users:password-reset', 10, HOUR),
  /** Connect and enrol are once-per-install steps: one bucket for both,
   *  the admin and the member routes alike. */
  pushEnrol: perLogin('push-enrol', 10),
  // A run of an app, per login: an Admin user's counts too (owner decision
  // 2026-10-24), so a wasteful app shows up when an Admin tests it.
  memberFrameTicket: appLimit(
    'member-frame-ticket',
    30,
    'starts (frame tickets)',
    'Keep the app open instead of reloading it.',
  ),
  // A view of a Present canvas, one ticket per frame load, per login: an
  // Admin user's counts too, as an app's run (the app limits' rule). No
  // app text: a canvas is not an app.
  memberCanvasFrameTicket: perLogin('member-canvas-frame-ticket', 30),
  /** A canvas frame document, per address: its ticket is in its URL and the
   *  canvas can read it, so a replay within the ticket's life is bounded. */
  canvasFrame: perIp('canvas-frame', 120),
  memberDbBroker: appLimit(
    'member-db-broker',
    600,
    'database calls (host.db.query and host.db.exec)',
    'Batch them: one query with IN (...) or a JOIN instead of one per row, one write with many rows instead of one per row, and save a text edit once typing stops.',
  ),
  memberToolBroker: appLimit(
    'member-tool-broker',
    120,
    'tool calls (host.tools.call)',
    'Batch them: one call for many rows (an IN list, a rows array) instead of one per row, keep what it already read, and call again only when the user acts.',
  ),
  // A member's bytes of a file: a thumbnail may decode an image.
  memberBytes: { ...perMember('member-bytes', 240), when: BYTES_ASKED },
  memberThumbs: { ...perMember('member-thumbs', 60), when: THUMB_ASKED },
  wsUserSearch: perLogin('ws-user-search', 60),
  /** A place in a folder's custom order, per login, an Admin user's too: a
   *  place may rank a whole folder (up to 5,000 rows, write.ts
   *  orderChildren). A person dragging and pressing Move up stays far
   *  under it. */
  treePlace: perLogin('tree-place', 120),
  // The messenger (plan page d8954876 section 14), per login: sends, the
  // other writes (edit, delete, react, read, clear, membership, pins),
  // typing (one per 3 s; stored nowhere) and the reads (the list, a
  // window, the catch-up a client runs on every event).
  messengerSend: perLogin('messenger-send', 60),
  messengerWrite: perLogin('messenger-write', 120),
  messengerTyping: perLogin('messenger-typing', 20),
  messengerRead: perLogin('messenger-read', 600),
  // People (plan page d8954876 section 23), per login: the cards, one
  // card, the presence poll and the photos a list draws.
  peopleRead: perLogin('people-read', 600),
  // Calls (plan page 886126b4 section 12), per login: a start or join (each
  // mints a token and makes a room), a token refresh (one an hour per
  // device, with room for a reconnect storm). The other call writes (leave,
  // end, remove, the agent stub) take messengerWrite.
  messengerCall: perLogin('messenger-call', 5),
  messengerCallToken: perLogin('messenger-call-token', 12),
  // LiveKit's webhooks, per address: a machine (the signature is the
  // credential; the handler refuses an unsigned body before any write).
  livekitWebhook: { ...perIp('livekit-webhook', 600), machine: true },
  // The /s link routes, per address: a stranger's requests.
  shareAggregate: perIp('share-aggregate', 120),
  shareBundle: perIp('share-bundle', 30),
  contactCode: perIp('contact-code:ip', 10),
  contactCodeHour: perIp('contact-code:ip-hour', 30, HOUR),
  shareDbBroker: perIp('share-db-broker', 300),
  shareDraw: perIp('share-draw', 240),
  shareDrawEmbed: perIp('share-draw-embed', 240),
  sharePresentEmbed: perIp('share-present-embed', 240),
  // A canvas's snapshot in a page, per login: a page with many canvases
  // loads one each, and a stamp asks ?meta=1 for each.
  presentPoster: perLogin('present-poster', 600),
  // A canvas's data store (DWG phase 7a), per login: what the canvas asks
  // through `mantle.data`, forwarded by its host page. Reads load a canvas's
  // marks or suggestions; writes save them (a meeting's markup, a vote).
  canvasData: perLogin('canvas-data', 600),
  canvasDataWrite: perLogin('canvas-data-write', 120),
  // A traced canvas's image check overview (the panel beside it): one
  // read of the drawing tables' Checks tabs per open.
  presentChecks: perLogin('present-checks', 120),
  shareEvaluate: perIp('share-evaluate', 60),
  shareFrameTicket: perIp('share-frame-ticket', 30),
  shareRows: perIp('share-rows', 120),
  shareToolBroker: perIp('share-tool-broker', 60),
  shareView: perIp('share-view', 120),
  shareAsset: perIp('share-asset', 240),
} as const satisfies Record<string, RateLimitSpec>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Whether `name` is a named limit. */
export function isRateLimitName(name: string): name is RateLimitName {
  return Object.hasOwn(RATE_LIMITS, name);
}

/** What the gate checks of a request before its handler, on one row: a
 *  route file's declaration states it (`limits`, route-declaration.ts; S9
 *  part 3, was ROUTE_GATES here), an /api/v1 alias takes its base's. A row
 *  that is reachable by a caller that is not an Admin user and has no limit
 *  is named in the docs and pinned (route-limits.test.ts), so a new one is a
 *  decision. */
export type RouteGates = Readonly<{
  /** The login-CSRF refusal of the public auth posts
   *  (refuseCrossSiteAuthPost): 'json' also refuses a body not declared
   *  JSON, 'origin' checks the origin only (sign-out). Before any limit,
   *  so a page on another site cannot spend a visitor's budget. */
  crossSite?: 'json' | 'origin';
  /** The named limits, taken in this order: every take, then the failure
   *  budgets. */
  rateLimit?: readonly RateLimitName[];
}>;

/** The one 429's text: what a person reads, whatever the limit. */
export const RATE_LIMITED_TEXT = 'Too many requests. Try again later.';

/** Who reads a 429: a person (the text in `error`) or a machine (an OAuth
 *  client, an MCP client, an API key's script), which reads `error` as a
 *  code. */
export type RateLimitedShape = 'person' | 'machine';

/**
 * The one 429 (A10 #8): `{ error, code: 'rate_limited', retryAfter }`, with
 * `Retry-After` (seconds, at least 1) and `Cache-Control: no-store`. The
 * seconds are in the body too: a browser on another origin cannot read the
 * header unless it is exposed. Every limit of this tier answers it, the
 * row's and the ones a handler still takes (route-plumbing.mjs
 * RATE_LIMIT_ALLOW), except the OAuth consent page, which answers a page.
 * A machine's 429 (`shape` 'machine': the OAuth server, the remote MCP, an
 * API key's budget) keeps the code it had in `error`, and the text moves to
 * `message`: `{ error: 'rate_limited', code, message, retryAfter }` (A10
 * lows, #8 L1: an OAuth client reads `error` as the RFC 6749 code).
 */
export function rateLimitedResponse(
  retryAfterSec: number,
  shape: RateLimitedShape = 'person',
  explain?: string,
): NextResponse {
  const a = rateLimitedAnswer(retryAfterSec, shape, explain);
  return NextResponse.json(a.body, { status: a.status, headers: a.headers });
}

/** The one 429 as its parts, for an answer that is built later (a chat
 *  turn's, which the turn route keeps for a retry with the same key). */
export function rateLimitedAnswer(
  retryAfterSec: number,
  shape: RateLimitedShape = 'person',
  explain?: string,
) {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  // A limit with an explanation (an app's, RateLimitSpec.explain) says it,
  // with the wait; every other limit the one text.
  const text = explain ? `${explain} Try again in ${sec} s.` : RATE_LIMITED_TEXT;
  const body =
    shape === 'machine'
      ? {
          error: 'rate_limited' as const,
          code: 'rate_limited' as const,
          message: text,
          retryAfter: sec,
        }
      : { error: text, code: 'rate_limited' as const, retryAfter: sec };
  return {
    status: 429 as const,
    body,
    headers: { 'Retry-After': String(sec), 'Cache-Control': CACHE_CONTROL.none },
  };
}

/** Who a login limit counts: the login the caller is, and whether it is a
 *  member (an Admin user is not counted by a members-only limit). */
export type LimitLogin = Readonly<{ loginId: string; member: boolean }>;

/** The key of `spec` for this request, or null when it does not count it
 *  (an Admin user on a members-only limit, a query it does not apply to). */
function keyOf(
  spec: RateLimitSpec,
  req: Request,
  query: URLSearchParams,
  login: LimitLogin | null,
) {
  if (spec.when && !spec.when.test(query)) return null;
  switch (spec.per) {
    case 'ip':
      return `${spec.bucket}:${clientIpKey(req)}`;
    case 'brain':
      return spec.bucket;
    case 'login':
      // Fail closed: a row takes a login limit only where its caller names
      // one (route-policy.ts gatesOf).
      if (!login)
        throw new Error(`takeRouteLimits: ${spec.bucket} counts a login, and none is named`);
      if (spec.members && !login.member) return null;
      return `${spec.bucket}:${login.loginId}`;
  }
}

/**
 * Take a row's limits (`names`, the row's `rateLimit`) whose scope is in
 * `scopes`: every take, then every failure budget. The one 429 when any is
 * over, else null. A take refused answers with the longest Retry-After of
 * all the takes (a caller who waits out the shortest is only refused by the
 * next: the rule the contact code's two limits had); a spent failure budget
 * with its own. `query`: the query the handler is handed (an /api/v1 row
 * may hand another than the one sent).
 */
export function takeRouteLimits(
  names: readonly RateLimitName[],
  o: Readonly<{
    req: Request;
    query?: URLSearchParams;
    login: LimitLogin | null;
    scopes: ReadonlySet<RateLimitScope>;
  }>,
): NextResponse | null {
  const query = o.query ?? new URL(o.req.url).searchParams;
  const takes: Array<[RateLimitSpec, RateLimitResult]> = [];
  const peeks: Array<[RateLimitSpec, string]> = [];
  const shape: RateLimitedShape = names.some((n) => (RATE_LIMITS[n] as RateLimitSpec).machine)
    ? 'machine'
    : 'person';
  for (const name of names) {
    const spec: RateLimitSpec = RATE_LIMITS[name];
    if (!o.scopes.has(spec.per)) continue;
    const key = keyOf(spec, o.req, query, o.login);
    if (key === null) continue;
    if (spec.peek) peeks.push([spec, key]);
    else takes.push([spec, rateLimit(key, spec)]);
  }
  const refused = takes.filter(([, t]) => !t.ok);
  if (refused.length > 0) {
    const explain = refused.find(([s]) => s.explain)?.[0].explain;
    return rateLimitedResponse(Math.max(...takes.map(([, t]) => t.retryAfterSec)), shape, explain);
  }
  for (const [spec, key] of peeks) {
    const seen = rateLimitPeek(key, spec);
    if (!seen.ok) return rateLimitedResponse(seen.retryAfterSec, shape, spec.explain);
  }
  return null;
}

/** Count one failure toward a failure budget (a `peek` limit: the brain's
 *  failed invite codes). */
export function countRateFailure(name: RateLimitName): void {
  const spec: RateLimitSpec = RATE_LIMITS[name];
  if (!spec.peek || spec.per !== 'brain') {
    throw new Error(`countRateFailure: ${name} is not a failure budget of the brain`);
  }
  rateLimit(spec.bucket, spec);
}

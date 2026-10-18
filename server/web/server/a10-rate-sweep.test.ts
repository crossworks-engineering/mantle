/**
 * The rate sweep (A10 #8: rate limits on the ROUTE_POLICY row;
 * docs/request-plumbing.md, "Rate limits"). Every route that took a rate
 * limit per request on main (SWEEP_CELLS, the inventory below) driven
 * through the full pipeline (the gate, the row, the caller's answer, the handler), as
 * the credential the limit counts, with the clock held still:
 *
 *  - count:   max + 1 requests: the first request refused (429), the answer
 *             just under the cap and the refusal itself (status, content
 *             type, Retry-After, Cache-Control, body);
 *  - window:  a full bucket, a second before its window ends and at its end;
 *  - scope:   a full bucket, then another address, another login of the
 *             same kind, and the same login from another address;
 *  - shared:  a full bucket, then each row that shares it;
 *  - order:   what the handler checked BEFORE the limit on main still comes
 *             first and spends nothing: a cross-site browser request, no
 *             login, an Admin user where only members count, a query that
 *             takes no limit, a request the user search refused itself;
 *  - budget:  the brain-wide invite failure caps, from a new address each
 *             time.
 *
 * No database (the login rows are stood in, as in the body sweep), no
 * network, no child process. Each probe starts a day after the one before,
 * so every bucket it meets is empty.
 *
 * Recorded on main (v0.300.44) BEFORE the move, in
 * __snapshots__/a10-rate-sweep.txt (A10_RATE_SWEEP_RECORD=1 writes it; a
 * normal run only reads it). After the move every probe must answer as
 * recorded, or be a named change (changeKind below), listed probe by probe
 * in __snapshots__/a10-rate-sweep-changes.txt.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN2_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER2_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

const loginRow = (id: string, role: string, isOwner = false) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  adminMember: role === 'admin',
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
});

vi.mock('../lib/brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  getBrainId: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === ANCHOR_ID
      ? loginRow(ANCHOR_ID, 'admin', true)
      : id === ADMIN2_ID
        ? loginRow(ADMIN2_ID, 'admin')
        : id === MEMBER_ID || id === MEMBER2_ID
          ? loginRow(id, 'member')
          : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
}));

vi.mock('../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: () => undefined,
}));

vi.mock('../lib/mcp-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpLoginEnabled: async () => false,
  mcpTargetLogin: async () => null,
  resolveMcpCaller: async () => null,
}));

vi.mock('../lib/mcp-oauth', async (importOriginal) => {
  const { SWEEP_OAUTH_CLIENT } = await import('./public-session-routes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    isRemoteMcpEnabled: async () => true,
    getClient: async (id: string) =>
      id === SWEEP_OAUTH_CLIENT.id
        ? { id, clientName: 'Sweep client', redirectUris: [SWEEP_OAUTH_CLIENT.redirectUri] }
        : null,
  };
});

vi.mock('../lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({
    id: '00000000-0000-4000-8000-0000000000c0',
    code: 'sweep-code-sweep-code-sweep',
    expiresAt: new Date('2026-10-01T00:01:30.000Z'),
  }),
  claimPairCode: async () => null,
  pairCodeStatus: async () => ({ status: 'pending', deviceLabel: null }),
}));

vi.mock('../lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveShareByToken: async () => null,
  resolveActiveShareRowByToken: async () => null,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRetiredTeamLinkToken: async () => false,
  isRetiredClientLinkToken: async () => false,
  // An unknown invite code: every preview and accept is a failed code.
  previewMemberInvite: async () => null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const refuse = () => {
    throw new Error('sweep: no child process');
  };
  return { ...real, spawn: refuse, exec: refuse, execFile: refuse, fork: refuse };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // The body sweep's stand-in: a query finds no row; a statement finds one
  // item the login may edit and manage; withViewer runs its function.
  const none: unknown = new Proxy(() => undefined, {
    get: (_t, k) =>
      k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, ko)
        : () => none,
  });
  const db = new Proxy(real.db, {
    get: (t, k) => {
      if (k === 'select') return () => none;
      if (k === 'execute') {
        return async () => [
          {
            id: '11111111-1111-4111-8111-111111111111',
            type: 'page',
            edit: true,
            manage: true,
            copy: false,
            home: null,
            held: false,
            // The user search's Moderator check (lib/workspaces.ts).
            ok: true,
          },
        ];
      }
      return Reflect.get(t, k);
    },
  });
  return {
    ...real,
    db,
    withViewer: ((_actsFor, fn) => fn()) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async () => true,
}));

import { SESSION_COOKIE_NAME } from '../lib/auth-constants';

// ── The inventory ───────────────────────────────────────────────────────────
//
// The route rate limits as main had them: every limit a route took per
// request, by hand, in its own file or in a helper its handler called first,
// with its bucket, the scope its key names, its max and its window. After
// the move the limits are rows of ROUTE_POLICY (lib/route-limits.ts), and
// the second test holds the table to this list, limit by limit.

/** Whose key a limit counts: the caller's address (clientIpKey), the
 *  login the caller is, or the whole brain (a failure budget). */
type SweepScope = 'ip' | 'login' | 'brain';

type SweepLimit = Readonly<{
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
type SweepCell = Readonly<{
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

const SWEEP_CELLS: readonly SweepCell[] = [
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

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}
const RECORD = process.env.A10_RATE_SWEEP_RECORD === '1';
const BASELINE = join(here, '__snapshots__/a10-rate-sweep.txt');
const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ADDRESS = '198.51.100.7';
const OTHER_ADDRESS = '198.51.100.8';
/** A browser on another site (refuseCrossSiteAuthPost refuses it). */
const CROSS_SITE = 'https://elsewhere.example.invalid';

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
}

/** The other login of a credential's kind (the scope probe). */
const OTHER_CRED: Record<SweepCell['cred'], string | null> = {
  none: null,
  owner: 'owner2',
  member: 'member2',
};

/** The cells' order for a limit of a row with more than one: the takes in
 *  the row's order, then the failure budgets. */
const isTake = (l: SweepLimit) => !l.peek;

describe.skipIf(!hasManifest)('A10 #8: every route limit answers as recorded on main', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    db: process.env.DATABASE_URL,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
    scale: process.env.MANTLE_RATE_LIMIT_SCALE,
  };
  const realFetch = globalThis.fetch;
  let app: import('hono').Hono;
  const creds: Record<string, Record<string, string>> = {};
  let day = 0;
  /** A fresh day: every bucket the probe meets is empty. */
  const freshDay = () => {
    const t = new Date(NOW.getTime() + day++ * DAY);
    vi.setSystemTime(t);
    return t.getTime();
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'a10-rate-sweep-secret-that-is-at-least-32-chars';
    delete process.env.DATABASE_URL;
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_RATE_LIMIT_SCALE;
    globalThis.fetch = (async () => {
      throw new Error('sweep: no network');
    }) as typeof fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const tokens = await import('../lib/auth/tokens');
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: 20 * 365 * 86_400 }).value}`,
    });
    creds.owner = cookie(ANCHOR_ID);
    creds.owner2 = cookie(ADMIN2_ID);
    creds.member = cookie(MEMBER_ID);
    creds.member2 = cookie(MEMBER2_ID);
    creds.none = {};
    const { createApp } = await import('./app');
    app = await createApp();
  }, 120_000);

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['DATABASE_URL', saved.db],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
      ['MANTLE_RATE_LIMIT_SCALE', saved.scale],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Ask = { cred?: string; address?: string; origin?: string; query?: string };

  async function send(cell: SweepCell, ask: Ask = {}, row = cell.row): Promise<Response> {
    const [method, pattern] = row.split(' ') as [string, string];
    const query = ask.query ?? cell.query ?? '';
    const body = method === 'GET' || method === 'HEAD' ? undefined : (cell.body ?? undefined);
    return app.request(`${concretePath(pattern)}${query}`, {
      method,
      headers: {
        ...creds[ask.cred ?? cell.cred],
        'x-forwarded-for': ask.address ?? ADDRESS,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(ask.origin ? { origin: ask.origin } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
  }

  /** A whole answer: status, content type, the rate headers and the body. */
  async function answer(res: Response): Promise<string> {
    const type = res.headers.get('content-type') ?? '';
    const parts = [
      String(res.status),
      type.split(';')[0] || '-',
      `retry-after=${res.headers.get('retry-after') ?? '-'}`,
      `cache-control=${res.headers.get('cache-control') ?? '-'}`,
    ];
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      parts.push(text.length > 300 ? `${text.slice(0, 300)}…(${text.length})` : text);
    }
    return parts.join(' ');
  }

  async function status(res: Response): Promise<number> {
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  }

  /** Send `n` requests; the place of the first 429 (1-based), or 0. */
  async function firstRefused(cell: SweepCell, n: number, ask: (i: number) => Ask = () => ({})) {
    for (let i = 1; i <= n; i++) {
      if ((await status(await send(cell, ask(i)))) === 429) return i;
    }
    return 0;
  }

  /** Requests spaced so the row's other limits never fill first: a limit
   *  whose cap is under this one's is met at most once per its window. */
  function spacing(cell: SweepCell, limit: SweepLimit): number {
    const others = cell.limits.filter((l) => l !== limit && isTake(l) && l.max <= limit.max);
    if (!others.length) return 0;
    return Math.max(...others.map((l) => Math.ceil(l.windowMs / l.max) + 1000));
  }

  /** Fill `limit`'s bucket to its cap and one over; the answers. */
  async function fill(cell: SweepCell, limit: SweepLimit, start: number) {
    const gap = spacing(cell, limit);
    let under = '-';
    let first = 0;
    let over = '-';
    for (let i = 1; i <= limit.max + 1; i++) {
      vi.setSystemTime(start + (i - 1) * gap);
      const res = await send(cell);
      if (res.status === 429) {
        if (!first) first = i;
        over = await answer(res);
        if (i < limit.max + 1) continue;
        break;
      }
      const s = await status(res);
      if (i === limit.max) under = String(s);
    }
    return { under, first, over, end: start + limit.max * gap };
  }

  async function probe(cell: SweepCell, limit: SweepLimit): Promise<[string, string][]> {
    const out: [string, string][] = [];
    const name = `${cell.row}${cell.query ?? ''} ${cell.cred} ${limit.bucket}`;
    const per = `${limit.scope} ${limit.max}/${limit.windowMs / 1000}s${limit.members ? ' members' : ''}`;
    if (limit.peek) {
      // The brain-wide failure cap: a new address every request, so no
      // address fills its own bucket; every request is a failed code.
      freshDay();
      const k = await firstRefused(cell, limit.max + 2, (i) => ({
        address: `203.0.113.${i % 250}`,
        ...(i >= 250 ? { address: `192.0.2.${i % 250}` } : {}),
      }));
      out.push([`${name} budget (${per})`, `first 429 at ${k}`]);
      return out;
    }
    // count
    let start = freshDay();
    const filled = await fill(cell, limit, start);
    out.push([
      `${name} count (${per})`,
      `first 429 at ${filled.first}; #${limit.max} ${filled.under}; over ${filled.over}`,
    ]);
    // window: a second before the window ends, and at its end
    vi.setSystemTime(start + limit.windowMs - 1000);
    const before = await answer(await send(cell));
    vi.setSystemTime(start + limit.windowMs);
    const after = await status(await send(cell));
    out.push([
      `${name} window`,
      `${limit.windowMs / 1000 - 1}s: ${before}; ${limit.windowMs / 1000}s: ${after}`,
    ]);
    // scope
    start = freshDay();
    await fill(cell, limit, start);
    const scope: string[] = [];
    scope.push(`other address ${await status(await send(cell, { address: OTHER_ADDRESS }))}`);
    const other = OTHER_CRED[cell.cred];
    if (other) {
      scope.push(`other login ${await status(await send(cell, { cred: other }))}`);
      scope.push(
        `other login, other address ${await status(await send(cell, { cred: other, address: OTHER_ADDRESS }))}`,
      );
    }
    out.push([`${name} scope`, scope.join('; ')]);
    // shared
    for (const sibling of cell.sharesWith ?? []) {
      start = freshDay();
      await fill(cell, limit, start);
      out.push([
        `${name} shared with ${sibling}`,
        String(await status(await send(cell, {}, sibling))),
      ]);
    }
    // order
    const fresh = async () => status(await send(cell));
    if (cell.crossSite) {
      freshDay();
      const k = await firstRefused(cell, limit.max + 1, () => ({ origin: CROSS_SITE }));
      const seen = await status(await send(cell, { origin: CROSS_SITE }));
      out.push([
        `${name} order: cross-site`,
        `first 429 at ${k}; answer ${seen}; then ${await fresh()}`,
      ]);
    }
    if (limit.scope === 'login') {
      freshDay();
      const k = await firstRefused(cell, limit.max + 1, () => ({ cred: 'none' }));
      const seen = await status(await send(cell, { cred: 'none' }));
      out.push([
        `${name} order: no login`,
        `first 429 at ${k}; answer ${seen}; then ${await fresh()}`,
      ]);
    }
    if (limit.members) {
      freshDay();
      const k = await firstRefused(cell, limit.max + 1, () => ({ cred: 'owner' }));
      out.push([`${name} order: an Admin user`, `first 429 at ${k}; then ${await fresh()}`]);
    }
    if (cell.freeQuery !== undefined) {
      freshDay();
      const k = await firstRefused(cell, limit.max + 1, () => ({ query: cell.freeQuery }));
      out.push([
        `${name} order: no limit for '${cell.freeQuery}'`,
        `first 429 at ${k}; then ${await fresh()}`,
      ]);
    }
    if (cell.earlyRefusal !== undefined) {
      freshDay();
      const k = await firstRefused(cell, limit.max + 1, () => ({ query: cell.earlyRefusal }));
      const seen = await status(await send(cell, { query: cell.earlyRefusal }));
      out.push([
        `${name} order: refused by the route '${cell.earlyRefusal}'`,
        `first 429 at ${k}; answer ${seen}; then ${await fresh()}`,
      ]);
    }
    return out;
  }

  async function driveAll(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const cell of SWEEP_CELLS) {
        for (const limit of [
          ...cell.limits.filter(isTake),
          ...cell.limits.filter((l) => !isTake(l)),
        ]) {
          for (const [k, v] of await probe(cell, limit)) out.set(k, v);
        }
      }
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
    return out;
  }

  function readBaseline(): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(BASELINE, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf(' => ');
      out.set(line.slice(0, at), line.slice(at + 4));
    }
    return out;
  }

  it('answers every route limit as recorded on main', async () => {
    const now = await driveAll();
    const lines = [...now].map(([probe, a]) => `${probe} => ${a}`);
    if (RECORD) {
      writeFileSync(
        BASELINE,
        [
          '# A10 #8: every route rate limit, recorded on main (v0.300.44) BEFORE the move.',
          '# Written once (A10_RATE_SWEEP_RECORD=1); a10-rate-sweep.test.ts reads it back',
          '# and holds every probe to it, or to a named change.',
          `# probes: ${now.size}`,
          ...lines,
          '',
        ].join('\n'),
      );
      return;
    }
    const before = readBaseline();
    expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...now].filter(([p, a]) => before.get(p) !== a);
    const unnamed = changed
      .filter(([p, a]) => changeKind(p, before.get(p)!, a) === null)
      .map(([p, a]) => `${p}: main ${before.get(p)}; now ${a}`);
    expect(unnamed).toEqual([]);
    const kinds = new Map<string, number>();
    for (const [p, a] of changed) {
      const k = changeKind(p, before.get(p)!, a)!;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    await expect(
      [
        '# A10 #8: the probes that answer otherwise than on main, each with its named',
        '# kind (changeKind, a10-rate-sweep.test.ts), its answer on main and now. Every',
        '# other probe of a10-rate-sweep.txt answers byte for byte as recorded.',
        ...[...kinds].map(([k, n]) => `# ${k}: ${n} probes`),
        ...changed.flatMap(([p, a]) => [
          `${p} [${changeKind(p, before.get(p)!, a)}]`,
          `  main ${before.get(p)}`,
          `  now  ${a}`,
        ]),
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a10-rate-sweep-changes.txt');
  }, 1_800_000);

  it('holds the row table to the limits recorded on main, limit by limit', async () => {
    // Every limited row of the inventory carries the same limits, and no
    // row of the policy carries one the inventory does not name.
    const { routeManifest } = await import('./route-manifest.gen');
    const { buildRoutePolicy } = await import('../lib/auth/route-policy');
    const { RATE_LIMITS } = await import('../lib/route-limits');
    const policy = buildRoutePolicy(routeManifest);
    const spec = (n: keyof typeof RATE_LIMITS) => {
      const l: import('../lib/route-limits').RateLimitSpec = RATE_LIMITS[n];
      return {
        bucket: l.bucket,
        scope: l.per,
        max: l.max,
        windowMs: l.windowMs,
        ...(l.members ? { members: true } : {}),
        ...(l.peek ? { peek: true } : {}),
      };
    };
    const byRow = new Map<string, SweepLimit[]>();
    for (const c of SWEEP_CELLS) {
      const have = byRow.get(c.row) ?? [];
      for (const l of c.limits) if (!have.some((h) => h.bucket === l.bucket)) have.push(l);
      byRow.set(c.row, have);
    }
    const sortB = (xs: object[]) =>
      [...xs].sort((a, b) => ((a as SweepLimit).bucket < (b as SweepLimit).bucket ? -1 : 1));
    for (const [row, limits] of byRow) {
      const r = policy.get(row);
      expect(r, row).toBeDefined();
      expect(sortB(r!.rateLimit.map(spec)), row).toEqual(sortB(limits.map((l) => ({ ...l }))));
    }
    const extra = [...policy.values()]
      .filter((r) => r.rateLimit.length > 0 && !byRow.has(r.key))
      .map((r) => r.key);
    expect(extra).toEqual([]);
  });
});

/** The one 429 (lib/route-limits.ts rateLimitedResponse), as `answer`
 *  writes it: R its Retry-After; a HEAD's body is empty. */
const ONE_429 =
  /429 application\/json retry-after=(\d+) cache-control=no-store (?:\{"error":"Too many requests\. Try again later\.","code":"rate_limited","retryAfter":(\d+)\})?/g;
/** The one 429 in its machine shape (A10 lows, #8 L1): the OAuth server's
 *  and the remote MCP's limits keep `error: 'rate_limited'`. */
const ONE_429_MACHINE =
  /429 application\/json retry-after=(\d+) cache-control=no-store (?:\{"error":"rate_limited","code":"rate_limited","message":"Too many requests\. Try again later\.","retryAfter":(\d+)\})?/g;
/** Any 429 answer on main, up to where the probe's text goes on. */
const MAIN_429 = /429 \S+ retry-after=(\S+) cache-control=\S+ .*?(?=; \d+s: |$)/g;

/**
 * The named changes, by probe and its answer now (null: none names it, and
 * the test fails):
 *
 *  - one-429: a limit's refusal is the one 429 (status 429, the same
 *    Retry-After, JSON `{ error, code, retryAfter }`, Cache-Control
 *    no-store), where each route answered a 429 of its own (four texts, a
 *    text body on three /s routes, two header spellings, no Cache-Control
 *    on most); every other part of the probe as on main;
 *  - one-429 (Retry-After added): the same, where main's 429 had no
 *    Retry-After (the user search's);
 *  - machine-429 (A10 lows, #8 L1): the one 429 in its machine shape on
 *    the remote MCP's and the OAuth server's rows: `error` stays the code
 *    `rate_limited` their clients read, the text is `message`; with
 *    `(Retry-After added)` where main's had none;
 *  - counted-before-the-route: the user search takes its limit before its
 *    own checks (the row's, the gate's), so a request the route refuses
 *    (an offset that is not a number, a Moderator check) counts toward the
 *    login's 60 a minute, where it was taken after them.
 */
function changeKind(probe: string, main: string, now: string): string | null {
  const nowOk = [...now.matchAll(ONE_429)].every((m) => !m[2] || m[1] === m[2]);
  const mark = (x: string, re: RegExp, keep: boolean) =>
    x.replace(re, (_all, r: string) => `<429 retry-after=${keep ? r : '?'}>`);
  if (/ (?:mcp|oauth:register|oauth:token) /.test(probe) && now.includes('429 ')) {
    const ok = [...now.matchAll(ONE_429_MACHINE)].every((m) => !m[2] || m[1] === m[2]);
    if (ok && mark(main, MAIN_429, true) === mark(now, ONE_429_MACHINE, true)) {
      return 'machine-429';
    }
    if (
      ok &&
      main.includes('retry-after=-') &&
      mark(main, MAIN_429, false) === mark(now, ONE_429_MACHINE, false)
    ) {
      return 'machine-429 (Retry-After added)';
    }
  }
  if (nowOk && now.includes('429 ')) {
    if (mark(main, MAIN_429, true) === mark(now, ONE_429, true)) return 'one-429';
    if (
      main.includes('retry-after=-') &&
      mark(main, MAIN_429, false) === mark(now, ONE_429, false)
    ) {
      return 'one-429 (Retry-After added)';
    }
  }
  if (
    probe.includes('ws-user-search order: refused by the route') &&
    main === 'first 429 at 0; answer 400; then 200' &&
    now === 'first 429 at 61; answer 429; then 429'
  ) {
    return 'counted-before-the-route';
  }
  // The A8 finding F1 (owner decision a, D3): a member reaches a v1 row as
  // its base route answers it. Main refused it there (403 member-login,
  // before any count); now the base route's member limit counts it, and
  // the item is the route's own answer (a 404 for the probe's id).
  if (
    probe.includes(' /api/v1/') &&
    probe.includes(' member ') &&
    main.includes(' 403') &&
    !/ (?:2\d\d|404)\b/.test(main) &&
    !now.includes(' 403')
  ) {
    return 'a8-f1-member-on-v1';
  }
  return null;
}

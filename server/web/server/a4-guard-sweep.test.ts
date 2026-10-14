/**
 * The guard sweep (arch A4 step 3a): for every route of the manifest and
 * every page, every method, and every kind of credential, what the request
 * gets and what each session guard answered on the way. Recorded on main
 * (v0.300.28) BEFORE the gate resolved the login, and committed: step 3a
 * moves the login's resolution into the gate and turns each guard into a
 * reader of the bound caller, and this file must not change.
 *
 * Per request it records the answer (status, the headers a client reads,
 * the body of a refusal) and, per guard call, the guard's answer (its
 * refusal, or the login it resolved), the actor the request runs as after
 * it, and what the guard did with the request's scope (the outcome). A
 * guard that lets a login through stops the handler right there (SweepStop),
 * so nothing past the guard runs: the sweep proves the guards, and no
 * handler touches a database it does not have.
 *
 * No database: the login rows, the device tokens and the keys come from
 * stand-ins, as in the member and role sweeps.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
/** An admin that holds no Admin area (requireArea answers false). */
const LIMITED_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const NODE_ID = '11111111-1111-4111-8111-111111111111';

const sweepState = vi.hoisted(() => ({
  bearers: new Map<
    string,
    { userId: string; revokedAt: Date | null; expiresAt: Date; rotatedTo: string | null }
  >(),
  /** The guard calls of the request being driven. */
  log: [] as string[],
}));

const loginRow = (id: string, role: string, isOwner = false) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
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
      : id === ADMIN_ID
        ? loginRow(ADMIN_ID, 'admin')
        : id === LIMITED_ID
          ? loginRow(LIMITED_ID, 'admin')
          : id === MEMBER_ID
            ? loginRow(MEMBER_ID, 'member')
            : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async (jti: string) => sweepState.bearers.get(jti) ?? null,
  touchBearerToken: async (jti: string) => {
    sweepState.log.push(`touch ${jti.slice(0, 8)}`);
  },
}));

vi.mock('../lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => false,
  mcpTargetLogin: async () => null,
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
    expiresAt: new Date(Date.now() + 90_000),
  }),
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
}));

// The keys: verified by their token, every budget open (no rate limit
// differs between two runs of the sweep).
vi.mock('../lib/access-keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/access-keys')>();
  const { KEY_GRANTS } = await import('./a4-guard-sweep.keys');
  const open = { ok: true as const, remaining: 1, retryAfterSec: 0 };
  return {
    ...real,
    verifyAccessKey: async (token: string) => {
      const grant = KEY_GRANTS[token];
      return grant ? { ok: true as const, grant } : { ok: false as const, reason: 'unknown' };
    },
    rateLimitAccessKey: () => open,
    rateLimitKeySearch: () => open,
    failedKeyBudget: () => open,
    countFailedKey: () => undefined,
    touchAccessKey: () => undefined,
    auditKeyRefusal: () => undefined,
  };
});

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  brainOnWorkspacesNow: async () => true,
  createHomeIntent: async () => ({ createWs: null, privateWs: null }),
}));
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED_ID,
}));

/** Thrown by a guard's stand-in once it let a login through: the handler
 *  goes no further. */
class SweepStop extends Error {
  constructor() {
    super('sweep stop');
    this.name = 'SweepStop';
  }
}

/** The session guards, each wrapped to record its answer. */
const GUARDS = [
  'getOwnerForAsset',
  'getMemberForAsset',
  'getReaderForAsset',
  'getSessionUserWithSource',
  'getSessionUser',
  'requireOwner',
  'requireOwnerForRender',
  'requireOwnerWithSource',
  'getOwnerOr401',
  'getOwnerOr401WithSource',
  'getOwnerOr401WithLogin',
  'getMemberOr401',
  'getLoginOr401',
  'getChatLoginOr401',
  'getCookieUpgradeLoginOr401',
] as const;

vi.mock('../lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const db = await import('@mantle/db');
  const { NextResponse } = await import('./http-compat');
  const { summarize } = await import('./a4-guard-sweep.keys');
  const after = () => {
    const actor = db.currentActor();
    const out = db.currentRequestOutcome();
    return (
      `actor=${actor ? db.actorSetting(actor) : '-'}` +
      ` out=${out ? `${out.kind}:${'why' in out ? out.why : 'writes' in out ? out.writes : ''}` : '-'}`
    );
  };
  const wrapped: Record<string, unknown> = { ...real, endLoginSessions: async () => 1 };
  for (const name of GUARDS) {
    const fn = real[name] as (...a: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      let value: unknown;
      try {
        value = await fn(...args);
      } catch (err) {
        const e = err as { name?: string; location?: string; message?: string };
        sweepState.log.push(
          `${name} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
        );
        throw err;
      }
      if (value instanceof NextResponse) {
        const body = await value.clone().text();
        sweepState.log.push(`${name} R${value.status} ${body.slice(0, 300)} ${after()}`);
        return value;
      }
      sweepState.log.push(`${name} ok ${summarize(value)} ${after()}`);
      if (value === null) return value;
      throw new SweepStop();
    };
  }
  return wrapped;
});

import { SESSION_COOKIE_NAME, RENDER_COOKIE_NAME } from '../lib/auth-constants';
import { KEY_TOKENS } from './a4-guard-sweep.keys';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, NODE_ID).replace(/\*$/, 'a/b');
}

/** One credential: its headers, and a query string it adds. GET only for
 *  the URL-borne ones (a GET is all they ever open). */
type Cred = { name: string; headers: Record<string, string>; query?: string; getOnly?: boolean };

/** The headers a client reads. */
const HEADERS = [
  'content-type',
  'cache-control',
  'location',
  'vary',
  'access-control-allow-origin',
  'retry-after',
  'www-authenticate',
];

describe.skipIf(!hasManifest)('A4 step 3a: every guard answers as on main', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let rows: Array<{ pattern: string; methods: string[] }>;
  let creds: Cred[];

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'a4-guard-sweep-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../lib/auth/tokens');
    const ttl = 30 * 24 * 60 * 60;
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: ttl }).value}`,
    });
    let n = 0;
    const bearer = (id: string, revoked = false) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, ttl, 0);
      sweepState.bearers.set(jti, {
        userId: id,
        revokedAt: revoked ? new Date() : null,
        expiresAt: t.expiresAt,
        rotatedTo: null,
      });
      return { authorization: `Bearer ${t.value}` };
    };
    const key = (token: string) => ({ authorization: `Bearer ${token}` });
    creds = [
      { name: 'none', headers: {} },
      { name: 'owner-cookie', headers: cookie(ANCHOR_ID) },
      { name: 'admin-cookie', headers: cookie(ADMIN_ID) },
      { name: 'limited-cookie', headers: cookie(LIMITED_ID) },
      { name: 'member-cookie', headers: cookie(MEMBER_ID) },
      { name: 'admin-bearer', headers: bearer(ADMIN_ID) },
      { name: 'member-bearer', headers: bearer(MEMBER_ID) },
      { name: 'revoked-bearer', headers: bearer(ADMIN_ID, true) },
      { name: 'key-read', headers: key(KEY_TOKENS.read) },
      { name: 'key-write', headers: key(KEY_TOKENS.write) },
      { name: 'key-read-area', headers: key(KEY_TOKENS.readArea) },
      { name: 'key-write-area', headers: key(KEY_TOKENS.writeArea) },
      { name: 'key-member', headers: key(KEY_TOKENS.member) },
      {
        name: 'asset-admin',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, ADMIN_ID))}`,
        getOnly: true,
      },
      {
        name: 'asset-member',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, MEMBER_ID))}`,
        getOnly: true,
      },
      {
        name: 'render',
        headers: {
          cookie: `${RENDER_COOKIE_NAME}=${tokens.buildRenderToken({
            ownerId: ANCHOR_ID,
            actorId: ADMIN_ID,
            nodeId: NODE_ID,
          })}`,
        },
        getOnly: true,
      },
      {
        name: 'frame-ticket',
        headers: {},
        query: `t=${encodeURIComponent(tokens.buildAppFrameTicket({ ownerId: ANCHOR_ID, appId: NODE_ID, actorId: ADMIN_ID }))}`,
        getOnly: true,
      },
    ];
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const [{ SHARE_PAGES }, { PRINT_PAGES }] = await Promise.all([
      import('./pages/share'),
      import('./pages/print'),
    ]);
    rows = [
      ...routeManifest.map((e) => ({ pattern: e.pattern, methods: [...e.methods] })),
      ...[...SHARE_PAGES, ...PRINT_PAGES].map((p) => ({
        pattern: p.pattern,
        methods: [...p.methods],
      })),
    ].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function drive(method: string, path: string, cred: Cred): Promise<string> {
    sweepState.log.length = 0;
    const url = cred.query ? `${path}${path.includes('?') ? '&' : '?'}${cred.query}` : path;
    const res = await app.request(url, {
      method,
      headers: { ...cred.headers, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
    });
    const parts = [String(res.status)];
    for (const h of HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) parts.push(`${h}=${h === 'location' ? v.replace(/\?.*$/, '?…') : v}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      // A refusal's body, and a guarded answer's: what the guard sent. A
      // route no guard serves keeps its own body (a version, a page) out.
      if (type.includes('json') && (sweepState.log.length > 0 || res.status >= 400)) {
        parts.push(text.slice(0, 300));
      }
    }
    for (const line of sweepState.log) parts.push(`[${line}]`);
    return parts.join(' ');
  }

  it('answers every route, method and credential as recorded on main', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = new Map<string, string>();
    const lines: string[] = [];
    let driven = 0;
    try {
      for (const row of rows) {
        const path = concretePath(row.pattern);
        const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
        for (const method of methods) {
          if (method === 'OPTIONS') continue;
          const cells: string[] = [];
          for (const cred of creds) {
            if (cred.getOnly && method !== 'GET') continue;
            const answer = await drive(method, path, cred);
            driven += 1;
            let id = answers.get(answer);
            if (!id) {
              id = `a${answers.size + 1}`;
              answers.set(answer, id);
            }
            cells.push(`${cred.name}=${id}`);
          }
          lines.push(`${method} ${row.pattern}: ${cells.join(' ')}`);
        }
      }
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
    }
    const table = [...answers].map(([answer, id]) => `${id} ${answer}`);
    expect(driven).toBeGreaterThan(10_000);
    await expect(
      ['# answers', ...table, '', '# routes', ...lines, ''].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep.txt');
  }, 1_200_000);
});

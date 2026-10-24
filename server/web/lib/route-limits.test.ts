/**
 * The rate limits of the ROUTE_POLICY row (A10 #8; docs/request-plumbing.md,
 * "Rate limits"): the one 429, how a row's limits are taken, every name of
 * ROUTE_GATES a served row, and the named list of the rows a caller other
 * than an Admin user reaches with no limit (pinned here and in the docs, so
 * a new one is a decision, not an accident).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RATE_LIMITS,
  RATE_LIMITED_TEXT,
  ROUTE_GATES,
  countRateFailure,
  rateLimitedResponse,
  takeRouteLimits,
  type RateLimitScope,
} from './route-limits';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '../server/route-manifest.gen.ts');
const ALL: ReadonlySet<RateLimitScope> = new Set(['ip', 'login', 'brain']);
let day = 0;

/** A request from `ip`, at `path`. */
const req = (ip: string, path = '/x') =>
  new Request(`http://brain.example.invalid${path}`, { headers: { 'x-forwarded-for': ip } });

describe('the one 429', () => {
  it('says one text, one code, the seconds in the body and in Retry-After, never cached', async () => {
    const res = rateLimitedResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: RATE_LIMITED_TEXT,
      code: 'rate_limited',
      retryAfter: 42,
    });
  });

  it('always says at least a second', () => {
    expect(rateLimitedResponse(0).headers.get('retry-after')).toBe('1');
  });
});

describe('takeRouteLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A fresh day per test: every bucket starts empty.
    vi.setSystemTime(new Date(Date.UTC(2030, 0, 1 + day++)));
  });
  afterEach(() => vi.useRealTimers());

  it('counts an address, an IPv6 caller by its /64', () => {
    const o = { login: null, scopes: ALL };
    for (let i = 0; i < 10; i++) {
      expect(takeRouteLimits(['authLogin'], { ...o, req: req(`2001:db8::${i}`) })).toBeNull();
    }
    expect(takeRouteLimits(['authLogin'], { ...o, req: req('2001:db8::ff') })?.status).toBe(429);
    expect(takeRouteLimits(['authLogin'], { ...o, req: req('2001:db8:1::1') })).toBeNull();
  });

  it('counts only members on a members-only limit', () => {
    const admin = { loginId: 'admin-1', member: false };
    const member = { loginId: 'member-1', member: true };
    const o = { req: req('192.0.2.1'), scopes: ALL };
    for (let i = 0; i < 20; i++)
      expect(takeRouteLimits(['chatTranscribe'], { ...o, login: admin })).toBeNull();
    for (let i = 0; i < 6; i++)
      expect(takeRouteLimits(['chatTranscribe'], { ...o, login: member })).toBeNull();
    expect(takeRouteLimits(['chatTranscribe'], { ...o, login: member })?.status).toBe(429);
  });

  it('counts an Admin user on the app limits too', () => {
    const admin = { loginId: 'admin-apps', member: false };
    const o = { req: req('192.0.2.4'), scopes: ALL, login: admin };
    for (let i = 0; i < 30; i++) expect(takeRouteLimits(['memberFrameTicket'], o)).toBeNull();
    expect(takeRouteLimits(['memberFrameTicket'], o)?.status).toBe(429);
    for (let i = 0; i < 120; i++) expect(takeRouteLimits(['memberToolBroker'], o)).toBeNull();
    expect(takeRouteLimits(['memberToolBroker'], o)?.status).toBe(429);
    for (let i = 0; i < 600; i++) expect(takeRouteLimits(['memberDbBroker'], o)).toBeNull();
    expect(takeRouteLimits(['memberDbBroker'], o)?.status).toBe(429);
  });

  it('takes the bytes or the thumbnail budget by the query, and none for the metadata', () => {
    const member = { loginId: 'member-2', member: true };
    const at = (q: string) => ({ req: req('192.0.2.2', `/f${q}`), login: member, scopes: ALL });
    const names = ['memberBytes', 'memberThumbs'] as const;
    for (let i = 0; i < 60; i++) expect(takeRouteLimits(names, at('?thumb=1'))).toBeNull();
    expect(takeRouteLimits(names, at('?thumb=1'))?.status).toBe(429);
    // The bytes have their own budget; the metadata takes none.
    expect(takeRouteLimits(names, at('?raw=1'))).toBeNull();
    for (let i = 0; i < 300; i++) expect(takeRouteLimits(names, at(''))).toBeNull();
  });

  it('answers the longest Retry-After when a row has two limits', () => {
    const o = { req: req('192.0.2.3'), login: null, scopes: ALL };
    for (let i = 0; i < 10; i++)
      expect(takeRouteLimits(['contactCode', 'contactCodeHour'], o)).toBeNull();
    const res = takeRouteLimits(['contactCode', 'contactCodeHour'], o);
    expect(res?.headers.get('retry-after')).toBe('3600');
  });

  it('looks at a failure budget and spends it only on a failure', () => {
    const fresh = (i: number) => ({ req: req(`198.51.100.${i}`), login: null, scopes: ALL });
    const names = ['inviteAccept', 'inviteAcceptFailures'] as const;
    for (let i = 0; i < 200; i++) expect(takeRouteLimits(names, fresh(i % 250))).toBeNull();
    for (let i = 0; i < RATE_LIMITS.inviteAcceptFailures.max; i++)
      countRateFailure('inviteAcceptFailures');
    expect(takeRouteLimits(names, fresh(251))?.status).toBe(429);
  });

  it('takes only the scopes asked (a public row: the login limit at the read)', () => {
    const o = { req: req('192.0.2.4'), login: null, scopes: new Set<RateLimitScope>(['ip']) };
    for (let i = 0; i < 20; i++) expect(takeRouteLimits(['authPairIssue'], o)).toBeNull();
  });

  it('fails closed: a login limit with no login named throws', () => {
    expect(() =>
      takeRouteLimits(['telegramPair'], { req: req('192.0.2.5'), login: null, scopes: ALL }),
    ).toThrow(/counts a login/);
  });

  it('counts a failure only on a failure budget of the brain', () => {
    expect(() => countRateFailure('authLogin')).toThrow(/not a failure budget/);
  });
});

/** Every row a caller other than an Admin user reaches with no limit, by
 *  how it is reached; a HEAD is its GET's, a gone stub answers 410 only. */
async function unlimitedRows(): Promise<Map<string, string[]>> {
  const { routeManifest } = await import('../server/route-manifest.gen');
  const { buildRoutePolicy } = await import('./auth/route-policy');
  const policy = buildRoutePolicy(routeManifest);
  const out = new Map<string, string[]>();
  for (const r of policy.values()) {
    if (r.gone || r.rateLimit.length || r.method === 'HEAD') continue;
    const reach = r.public
      ? r.class === 'link'
        ? 'link (a share token)'
        : 'public (no credential, or its own)'
      : r.caller === 'frame'
        ? 'frame (a frame ticket)'
        : r.logins === 'owner'
          ? 'owner rows open to members'
          : r.logins
            ? `${r.logins} logins`
            : null;
    if (!reach) continue;
    out.set(reach, [...(out.get(reach) ?? []), r.key]);
  }
  for (const v of out.values()) v.sort();
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const listText = (rows: Map<string, string[]>) =>
  [...rows]
    .flatMap(([reach, keys]) => [`${reach} (${keys.length}):`, ...keys.map((k) => `  ${k}`)])
    .join('\n');

describe.skipIf(!existsSync(MANIFEST))('the rows', () => {
  it('names every ROUTE_GATES key as a served row', async () => {
    const { routeManifest } = await import('../server/route-manifest.gen');
    const { buildRoutePolicy } = await import('./auth/route-policy');
    const policy = buildRoutePolicy(routeManifest);
    expect([...ROUTE_GATES.keys()].filter((k) => !policy.has(k))).toEqual([]);
    // Each named limit is some row's.
    const used = new Set([...policy.values()].flatMap((r) => r.rateLimit));
    expect(Object.keys(RATE_LIMITS).filter((n) => !used.has(n as never))).toEqual([]);
  });

  it('pins the rows a caller other than an Admin user reaches with no limit (UNLIMITED_NON_OWNER_ROWS)', async () => {
    const text = listText(await unlimitedRows());
    await expect(`${text}\n`).toMatchFileSnapshot('./__snapshots__/route-limits-unlimited.txt');
    // The docs carry the same list, between its markers.
    const doc = readFileSync(join(here, '../../../docs/request-plumbing.md'), 'utf8');
    const start = doc.indexOf('<!-- UNLIMITED_NON_OWNER_ROWS start -->');
    const end = doc.indexOf('<!-- UNLIMITED_NON_OWNER_ROWS end -->');
    expect(start).toBeGreaterThan(0);
    const block = doc.slice(start, end).split('```')[1] ?? '';
    expect(block.trim()).toBe(text.trim());
  });
});

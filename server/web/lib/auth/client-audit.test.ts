/**
 * The client gate's audit row (client tier audit 2026-09-30, I4): every
 * client write writes an `api.write` row. (The app broker carve-out went
 * with the client portal's apps in workspaces W5c: the client routes are
 * 410 stubs, still audited like any client write.) No database: the login
 * row is stood in, and the audit insert is a spy.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '12121212-1212-4212-8212-121212121212';
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const APP = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({ audited: [] as Array<Record<string, unknown>> }));

vi.mock('./login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === CLIENT_ID
      ? {
          id,
          email: 'casey@example.invalid',
          isOwner: false,
          displayName: 'Casey',
          role: 'client',
          contactId: null,
          disabledAt: null,
          sessionEpoch: 0,
        }
      : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => '66666666-6666-4666-8666-666666666666',
}));
vi.mock('../audit', () => ({
  auditFireAndForget: (row: Record<string, unknown>) => h.audited.push(row),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

let getClientOr401: typeof import('./session').getClientOr401;
let run: typeof import('../../server/request-context').runWithRequestContext;
let cookie: string;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'client-audit-secret-that-is-at-least-32-chars';
  const session = await import('./session');
  getClientOr401 = session.getClientOr401;
  run = (await import('../../server/request-context')).runWithRequestContext;
  const tokens = await import('./tokens');
  const { SESSION_COOKIE_NAME } = await import('../auth-constants');
  cookie = `${SESSION_COOKIE_NAME}=${
    tokens.buildSessionCookie(CLIENT_ID, { ttlSeconds: session.CLIENT_SESSION_TTL_SECONDS }).value
  }`;
});

beforeEach(() => {
  h.audited.length = 0;
});

const callAs = (method: string, path: string) =>
  run({ req: new Request(`http://x${path}`, { method, headers: { cookie } }), path, method }, () =>
    getClientOr401(),
  );

describe('client audit rows', () => {
  it('writes one for every client write, the old app brokers included', async () => {
    const res = await callAs('POST', `/api/client/apps/${APP}/db-broker`);
    expect(res).toMatchObject({ role: 'client', loginId: CLIENT_ID });
    await callAs('POST', '/api/client/space');
    expect(h.audited.map((r) => [r.action, r.path, r.actorId])).toEqual([
      ['api.write', `/api/client/apps/${APP}/db-broker`, CLIENT_ID],
      ['api.write', '/api/client/space', CLIENT_ID],
    ]);
  });

  it('a route any login may call: auditLoginMutation writes the row, getLoginOr401 alone none (W5a audit M2)', async () => {
    const session = await import('./session');
    const shared = (method: string, path: string) =>
      run(
        { req: new Request(`http://x${path}`, { method, headers: { cookie } }), path, method },
        async () => {
          const login = await session.getLoginOr401();
          if (login instanceof Response) throw new Error('no login');
          expect(h.audited).toEqual([]);
          await session.auditLoginMutation(login);
        },
      );
    await shared('GET', '/api/workspaces');
    expect(h.audited).toEqual([]);
    await shared('POST', '/api/workspaces');
    expect(h.audited.map((r) => [r.action, r.method, r.path, r.actorId])).toEqual([
      ['api.write', 'POST', '/api/workspaces', CLIENT_ID],
    ]);
  });
});

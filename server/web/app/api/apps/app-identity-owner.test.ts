/**
 * App identity on the OWNER surface (docs/app-authoring-guide.md, "Who is
 * running the app"): the admin login fills the reserved :host_me_*
 * parameters in the owner db broker, the owner frame ticket names that login
 * (`act`), and the owner frame bakes it in for host.me(). Without a database:
 * the brokers' SQLite and the frame renderer are stand-ins; the real binding
 * is pinned in packages/content/src/app-viewer.broker.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN_LOGIN = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  callers: [] as unknown[],
  frameViewers: [] as unknown[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    email: 'admin@example.invalid',
    actor: {
      id: ADMIN_LOGIN,
      email: 'admin@example.invalid',
      displayName: 'Robin',
      isOwner: false,
    },
  })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getAppRuntime: vi.fn(async () => ({
    id: APP,
    manifest: { sqlite: undefined },
    draftBuild: { ok: true, storageKey: 'draft-key' },
    publishedBuild: null,
  })),
}));
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  AppSqlError: (await importOriginal<typeof import('@mantle/content/app-broker')>()).AppSqlError,
  AppSqlBusyError: (await importOriginal<typeof import('@mantle/content/app-broker')>())
    .AppSqlBusyError,
  AppDbMissingError: (await importOriginal<typeof import('@mantle/content/app-broker')>())
    .AppDbMissingError,
  appDbQuery: vi.fn(async (...args: unknown[]) => (h.callers.push(args[5]), [])),
  appDbExec: vi.fn(async (...args: unknown[]) => (h.callers.push(args[5]), { changes: 1 })),
}));
vi.mock('@mantle/content/app-table-exports', () => ({ scheduleAppTableExportSync: vi.fn() }));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async (_req: Request, _build: unknown, opts?: { viewer?: unknown }) => {
    h.frameViewers.push(opts?.viewer);
    return new Response('<!doctype html>', { status: 200 });
  }),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'owner-identity-test-secret-at-least-32-chars!!';
});
beforeEach(() => {
  h.callers.length = 0;
  h.frameViewers.length = 0;
});

const params = () => ({ params: Promise.resolve({ id: APP }) });
const post = (body: unknown) =>
  new Request(`https://brain.example.invalid/api/apps/${APP}/db-broker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('owner db broker', () => {
  it('fills :host_me_* from the admin login on a query and a write', async () => {
    const { POST } = await import('./[id]/db-broker/route');
    expect((await POST(post({ op: 'query', sql: 'select 1' }), params())).status).toBe(200);
    expect(
      (await POST(post({ op: 'exec', sql: 'insert into t values (1)' }), params())).status,
    ).toBe(200);
    const caller = {
      callerKey: `admin:${ADMIN_LOGIN}`,
      viewer: { kind: 'admin', loginId: ADMIN_LOGIN, name: 'Robin' },
    };
    expect(h.callers).toEqual([caller, caller]);
  });
});

describe('owner frame: host.me()', () => {
  it('the ticket names the admin login, and the frame bakes it in', async () => {
    const ticketRoute = (await import('./[id]/frame-ticket/route')).POST;
    const frame = (await import('./[id]/frame/route')).GET;
    const { verifyAppFrameTicket } = await import('@/lib/auth');
    const res = await ticketRoute(new Request('https://brain.example.invalid/x'), params());
    const { ticket } = (await res.json()) as { ticket: string };
    expect(verifyAppFrameTicket(ticket)).toMatchObject({ ownerId: OWNER, actorId: ADMIN_LOGIN });

    const f = await frame(
      new Request(`https://brain.example.invalid/api/apps/${APP}/frame?t=${ticket}`),
      params(),
    );
    expect(f.status).toBe(200);
    expect(h.frameViewers).toEqual([
      { ownerId: OWNER, appId: APP, subject: { kind: 'admin', loginId: ADMIN_LOGIN } },
    ]);
  });
});

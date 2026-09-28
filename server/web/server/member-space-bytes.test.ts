/**
 * GET /api/member/space/:id/bytes with a member `?at=` token and no session,
 * through the real app (gate plus route). The gate admits the token on this
 * path; the route then reads in the space of the member the token's `act`
 * names, so the token opens that member's own file and never another
 * member's: another member's file is a 404, and their space is never opened.
 *
 * No database: the login rows and personal spaces come from a stand-in
 * (lib/auth/login-row is mocked), `withSpace` runs its callback directly,
 * and `openMineFile` reads a two-file stand-in store keyed by space, the way
 * row security keys the real one.
 */
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A = '22222222-2222-4222-8222-222222222222';
const MEMBER_B = '99999999-9999-4999-8999-999999999999';
const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({
  spaceOf: (loginId: string) => `${loginId.slice(0, 8)}-0000-4000-8000-000000000000`,
  opened: [] as string[],
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === '22222222-2222-4222-8222-222222222222' || id === '99999999-9999-4999-8999-999999999999'
      ? {
          id,
          email: `${id.slice(0, 4)}@example.invalid`,
          isOwner: false,
          displayName: null,
          role: 'member',
          contactId: null,
          disabledAt: null,
        }
      : null,
  loadAnchorId: async () => '33333333-3333-4333-8333-333333333333',
  loadPersonalSpaceId: async (loginId: string) => h.spaceOf(loginId),
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  withSpace: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@mantle/content', async (orig) => {
  const actual = await orig<typeof import('@mantle/content')>();
  // Each file lives in its author's space: A's in A's, B's in B's.
  const store: Record<string, string> = {
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': h.spaceOf('22222222-2222-4222-8222-222222222222'),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': h.spaceOf('99999999-9999-4999-8999-999999999999'),
  };
  return {
    ...actual,
    openMineFile: async (spaceId: string, id: string) => {
      h.opened.push(spaceId);
      if (store[id] !== spaceId) return null;
      const bytes = Buffer.from(`bytes of ${id}`);
      return {
        file: { id, filename: `${id}.txt`, mimeType: 'text/plain', sha256: null },
        spaceId,
        stream: Readable.from([bytes]),
        size: bytes.byteLength,
      };
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
// vitest.global-setup.ts generates the manifest; in CI a missing one is a
// failure, never a silent skip of a security sweep.
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

describe.skipIf(!hasManifest)('member space bytes: a member ?at= token', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let bytes: (fileId: string, login: string) => Response | Promise<Response>;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'member-space-bytes-secret-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const { buildAssetToken } = await import('../lib/auth/tokens');
    const { createApp } = await import('./app');
    app = await createApp();
    bytes = (fileId, login) =>
      app.request(
        `/api/member/space/${fileId}/bytes?at=${encodeURIComponent(buildAssetToken(ANCHOR_ID, login))}`,
      );
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

  beforeEach(() => {
    h.opened.length = 0;
  });

  it("opens the member's own file (the gate admits the token on this path)", async () => {
    const res = await bytes(FILE_A, MEMBER_A);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`bytes of ${FILE_A}`);
    expect(h.opened).toEqual([h.spaceOf(MEMBER_A)]);
  });

  it("refuses another member's file: a 404, read only in the token's own space", async () => {
    const res = await bytes(FILE_B, MEMBER_A);
    expect(res.status).toBe(404);
    expect(h.opened).toEqual([h.spaceOf(MEMBER_A)]);
    // The same file opens for its own author, so the 404 is the scoping.
    expect((await bytes(FILE_B, MEMBER_B)).status).toBe(200);
  });

  it('refuses a token minted under another anchor before any space is read', async () => {
    const { buildAssetToken } = await import('../lib/auth/tokens');
    const other = buildAssetToken('88888888-8888-4888-8888-888888888888', MEMBER_A);
    const res = await app.request(
      `/api/member/space/${FILE_A}/bytes?at=${encodeURIComponent(other)}`,
    );
    expect(res.status).toBe(401);
    expect(h.opened).toEqual([]);
  });
});

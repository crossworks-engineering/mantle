/**
 * The render surfaces and the render cookie through the real app (gate plus
 * route), audit F01. The browser sidecar carries a render cookie (kind 'r')
 * for the acting admin and one node. It opens that node's /print or /render
 * page, with a CSP that allows nothing outside this origin, and the byte
 * routes the page loads. It opens no other page, no other API and never the
 * admin private-space bytes, and a member or disabled login's cookie opens
 * nothing.
 *
 * No database: login rows are stood in (lib/auth/login-row is mocked), and
 * the content reads return fixed rows.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const DISABLED = '88888888-8888-4888-8888-888888888888';
const PAGE = '44444444-4444-4444-8444-444444444444';
const OTHER_PAGE = '44444444-4444-4444-8444-000000000000';
const DRAW = '77777777-7777-4777-8777-777777777777';
const FILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({ fileReads: [] as string[] }));

vi.mock('../lib/auth/login-row', () => {
  const rows: Record<string, Record<string, unknown>> = {
    '33333333-3333-4333-8333-333333333333': { isOwner: true, role: 'admin', disabledAt: null },
    '55555555-5555-4555-8555-555555555555': { isOwner: false, role: 'admin', disabledAt: null },
    '22222222-2222-4222-8222-222222222222': { isOwner: false, role: 'member', disabledAt: null },
    '88888888-8888-4888-8888-888888888888': {
      isOwner: false,
      role: 'admin',
      disabledAt: new Date(0),
    },
  };
  return {
    loadLoginRow: async (id: string) =>
      rows[id]
        ? {
            id,
            email: `${id.slice(0, 4)}@example.invalid`,
            displayName: null,
            contactId: null,
            ...rows[id],
          }
        : null,
    loadAnchorId: async () => '33333333-3333-4333-8333-333333333333',
    loadPersonalSpaceId: async (id: string) => `${id.slice(0, 8)}-0000-4000-8000-000000000000`,
  };
});

vi.mock('@mantle/content', async (orig) => ({
  ...(await orig<typeof import('@mantle/content')>()),
  getPage: async (_owner: string, id: string) =>
    id === '44444444-4444-4444-8444-444444444444'
      ? {
          title: 'Notes',
          width: 'narrow',
          doc: {
            type: 'doc',
            content: [
              { type: 'image', attrs: { src: 'https://attacker.example/pixel.png' } },
              { type: 'image', attrs: { nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
            ],
          },
        }
      : null,
  getDrawSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  getDraw: async () => ({ scene: { elements: [] }, fileRefs: {} }),
}));

vi.mock('./pages/appearance', () => ({ loadAppearanceAttrs: async () => undefined }));

vi.mock('../lib/files', async (orig) => ({
  ...(await orig<typeof import('../lib/files')>()),
  readFileById: async ({ ownerId, fileId }: { ownerId: string; fileId: string }) => {
    h.fileReads.push(ownerId);
    return fileId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ? { bytes: Buffer.from('png'), row: { mimeType: 'image/png', filename: 'a.png' } }
      : null;
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('render surfaces and the render cookie', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let tokens: typeof import('../lib/auth/tokens');
  let print: typeof import('./pages/print');

  const cookieFor = (actorId: string, nodeId: string) =>
    `mantle_render=${tokens.buildRenderToken({ ownerId: ANCHOR, actorId, nodeId })}`;
  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'print-render-test-secret-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    tokens = await import('../lib/auth/tokens');
    print = await import('./pages/print');
    const { createApp } = await import('./app');
    app = await createApp();
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
    h.fileReads.length = 0;
  });

  it('prints the page the cookie names, with a CSP that refuses outside origins', async () => {
    const res = await get(`/print/pages/${PAGE}`, cookieFor(ADMIN, PAGE));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(print.PRINT_CSP);
    // Only this origin (plus inline data:/blob:), and no script at all.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toMatch(/https?:|\*/);
    expect(csp).not.toContain('script-src');
    // The outside image is still in the markup: the CSP (and the sidecar's
    // interception) is what stops it loading.
    expect(await res.text()).toContain('https://attacker.example/pixel.png');
  });

  it('sends the CSP on the draw print and render surfaces too', async () => {
    const printed = await get(`/print/draws/${DRAW}`, cookieFor(ADMIN, DRAW));
    expect(printed.status).toBe(200);
    expect(printed.headers.get('content-security-policy')).toBe(print.PRINT_CSP);
    const rendered = await get(`/render/draws/${DRAW}`, cookieFor(ADMIN, DRAW));
    expect(rendered.status).toBe(200);
    const csp = rendered.headers.get('content-security-policy')!;
    expect(csp).toBe(print.RENDER_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it('opens only the node the cookie names', async () => {
    const res = await get(`/print/pages/${OTHER_PAGE}`, cookieFor(ADMIN, PAGE));
    expect(res.status).toBe(307);
    expect((await get(`/print/draws/${DRAW}`, cookieFor(ADMIN, PAGE))).status).toBe(307);
  });

  it('opens the page images as the anchor brain, and nothing beyond the render routes', async () => {
    const img = await get(`/api/files/files/${FILE}?raw=1`, cookieFor(ADMIN, PAGE));
    expect(img.status).toBe(200);
    expect(h.fileReads).toEqual([ANCHOR]);
    // Never the admin private-space bytes, never a JSON API, never an app page.
    expect((await get(`/api/admin/space/${ITEM}/bytes`, cookieFor(ADMIN, PAGE))).status).toBe(401);
    expect((await get('/api/pages', cookieFor(ADMIN, PAGE))).status).toBe(401);
    expect((await get('/settings', cookieFor(ADMIN, PAGE))).status).toBe(307);
  });

  it("refuses a member's or a disabled admin's render cookie", async () => {
    for (const login of [MEMBER, DISABLED]) {
      expect((await get(`/print/pages/${PAGE}`, cookieFor(login, PAGE))).status, login).toBe(307);
      expect(
        (await get(`/api/files/files/${FILE}?raw=1`, cookieFor(login, PAGE))).status,
        login,
      ).toBe(401);
    }
    expect(h.fileReads).toEqual([]);
  });

  it('is never read as a session cookie', async () => {
    const value = tokens.buildRenderToken({ ownerId: ANCHOR, actorId: ADMIN, nodeId: PAGE });
    const res = await get(`/print/pages/${PAGE}`, `mantle_session=${value}`);
    expect(res.status).toBe(307);
  });
});

describe('getOwnerForAsset: the render cookie at the route layer', () => {
  it('opens the render byte routes only, as the acting admin', async () => {
    process.env.SESSION_SECRET = 'print-render-test-secret-at-least-32-chars';
    const { runWithRequestContext } = await import('./request-context');
    const { getOwnerForAsset } = await import('../lib/auth/session');
    const { buildRenderToken } = await import('../lib/auth/tokens');
    const cookie = `mantle_render=${buildRenderToken({ ownerId: ANCHOR, actorId: ADMIN, nodeId: PAGE })}`;
    const call = (path: string, method = 'GET') => {
      const req = new Request(`http://web:3000${path}`, { method, headers: { cookie } });
      return runWithRequestContext({ req, path, method }, () => getOwnerForAsset(req));
    };
    const ok = await call(`/api/files/files/${FILE}`);
    expect(ok).not.toBeInstanceOf(Response);
    expect(ok).toMatchObject({ id: ANCHOR, actor: { id: ADMIN } });
    expect(await call(`/api/draws/${DRAW}/svg`)).not.toBeInstanceOf(Response);
    // The route layer refuses it on every other asset route, whatever the gate did.
    for (const path of [`/api/admin/space/${ITEM}/bytes`, `/api/export/${PAGE}`, '/api/profile/photo']) {
      const res = await call(path);
      expect(res, path).toBeInstanceOf(Response);
      expect((res as Response).status, path).toBe(401);
    }
    const post = await call(`/api/files/files/${FILE}`, 'POST');
    expect((post as Response).status).toBe(401);
  });
});

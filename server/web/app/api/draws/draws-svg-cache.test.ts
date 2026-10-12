/**
 * The caching header of a drawing's SVG bytes (workspaces W7d+e). Since W7e
 * a member reads a drawing in its own scope, which a Moderator may narrow at
 * any time, so a member's bytes are `private, no-cache` (the browser
 * revalidates before reuse, and the scoped lookup runs again), on the owner
 * route (?raw=1; the member route is gone since W8d). The owner's own bytes
 * keep their short private cache.
 *
 * No database: the gates and the drawing reads are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const DRAW = '22222222-2222-4222-8222-222222222222';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

const h = vi.hoisted(() => ({ member: false }));

const memberCaller = {
  role: 'member',
  loginId: '33333333-3333-4333-8333-333333333333',
  anchorId: '11111111-1111-4111-8111-111111111111',
  email: 'm@example.invalid',
  displayName: 'M',
  contactId: null,
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReaderForAsset: vi.fn(async () => ({
    user: { id: OWNER, actor: { id: OWNER } },
    member: h.member ? memberCaller : null,
  })),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withViewer: vi.fn(async (_o: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDrawSvg: vi.fn(async () => SVG),
  scopedDrawSvg: vi.fn(async (_o: string, _id: string, svg: string) => svg),
}));
vi.mock('@/lib/draw-snapshot', () => ({
  getDrawSvgOrRender: vi.fn(async () => SVG),
}));

const ownerRoute = await import('./[id]/svg/route');
const params = { params: Promise.resolve({ id: DRAW }) };

beforeEach(() => {
  h.member = false;
});

describe('drawing SVG bytes: cache headers', () => {
  it("a member's raw bytes on the owner route are private, no-cache", async () => {
    h.member = true;
    const res = await ownerRoute.GET(new Request(`http://x/api/draws/${DRAW}/svg?raw=1`), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
  });

  it("the owner's own raw bytes keep their short private cache", async () => {
    const res = await ownerRoute.GET(new Request(`http://x/api/draws/${DRAW}/svg?raw=1`), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });
});

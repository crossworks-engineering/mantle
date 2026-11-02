/**
 * /s/<token> of a Present canvas (docs/proposals/canvas-files.md 7.2),
 * without a database: the page is shell-less, as an app's, and carries only
 * the presenter island (the canvas's source never lands in the document).
 * It answers `frame-src 'self'`, so a canvas that navigates its own frame
 * cannot reach another site (section 5.3). A page of another kind carries no
 * such header.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CANVAS = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({ kind: 'present' as 'present' | 'note' }));

const share = () => ({
  id: 'share-1',
  ownerId: 'owner-1',
  nodeId: CANVAS,
  nodeType: h.kind,
  contactId: null,
  settings: {},
});

vi.mock('@/lib/shares', () => ({
  resolveActiveShareByToken: vi.fn(async (token: string) =>
    token === 'live-tok' ? share() : null,
  ),
  resolveActiveShareRowByToken: vi.fn(async (token: string) =>
    token === 'live-tok' ? share() : null,
  ),
  loadShareView: vi.fn(async () =>
    h.kind === 'present'
      ? { kind: 'present', presentId: CANVAS, title: 'Pump deck' }
      : { kind: 'note', title: 'Minutes', content: 'hello' },
  ),
  recordShareView: vi.fn(async () => {}),
  sharePresentsShown: vi.fn(async () => new Set<string>()),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  isRetiredTeamLinkToken: vi.fn(async () => false),
  isRetiredClientLinkToken: vi.fn(async () => false),
}));

vi.mock('./appearance', () => ({
  loadShareAppearance: vi.fn(async () => ({
    attrs: undefined,
    defaultMode: 'light',
    neatBackground: null,
  })),
}));

beforeEach(() => {
  h.kind = 'present';
});

const app = async () => {
  const { SHARE_PAGES } = await import('./share');
  const { gate } = await import('../middleware/gate');
  const { registerPages } = await import('../route-loader');
  const a = new Hono();
  a.use('*', gate());
  registerPages(a, SHARE_PAGES, 'link');
  return a;
};

describe('/s/<token> of a Present canvas', () => {
  it("is the presenter island alone, with frame-src 'self'", async () => {
    const res = await (await app()).request('/s/live-tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-src 'self'; child-src 'self'; frame-ancestors 'self'",
    );
    const html = await res.text();
    expect(html).toContain('data-island="canvas"');
    expect(html).toContain('Pump deck');
    expect(html).toContain('noindex');
    // No source and no frame in the document: the island mints the ticket.
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('/canvas/frame?');
  });

  it('a page of another kind carries no CSP of its own', async () => {
    h.kind = 'note';
    const res = await (await app()).request('/s/live-tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

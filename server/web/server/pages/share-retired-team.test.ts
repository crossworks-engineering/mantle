/**
 * /s/<token> after team links were retired (member logins Phase 6 stage 6),
 * without a database. An old team link (revoked by migration 0176) answers a
 * plain "sign in as a member" page (410) pointing at /login, never the
 * content and never the old token prompt; any other dead token keeps the
 * uniform 404; a live link renders with no team gate in front of it.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  live: new Set<string>(),
  team: new Set<string>(),
}));

vi.mock('@/lib/shares', () => ({
  resolveActiveShareByToken: vi.fn(async (token: string) =>
    h.live.has(token)
      ? { id: 'share-1', ownerId: 'owner-1', nodeId: 'node-1', nodeType: 'note', settings: {} }
      : null,
  ),
  // The /s gate (contact shares, 0214) resolves through this one.
  resolveActiveShareRowByToken: vi.fn(async (token: string) =>
    h.live.has(token)
      ? { id: 'share-1', ownerId: 'owner-1', nodeId: 'node-1', nodeType: 'note', settings: {} }
      : null,
  ),
  loadShareView: vi.fn(async () => ({ kind: 'note', title: 'Minutes', content: 'hello' })),
  recordShareView: vi.fn(async () => {}),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  isRetiredTeamLinkToken: vi.fn(async (token: string) => h.team.has(token)),
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
  h.live = new Set(['live-tok']);
  h.team = new Set(['old-team-tok']);
});

const app = async () => {
  const { mountShare } = await import('./share');
  const a = new Hono();
  mountShare(a);
  return a;
};

describe('/s/<token> with team links retired', () => {
  it('tells an old team link to sign in as a member (410, a link to /login)', async () => {
    const res = await (await app()).request('/s/old-team-tok');
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('Sign in as a member');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('team-token-prompt');
    expect(html).toContain('noindex');
  });

  it('keeps the plain 404 for any other dead token', async () => {
    const res = await (await app()).request('/s/unknown-tok');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Sign in as a member');
  });

  it('renders a live link with no team gate', async () => {
    const res = await (await app()).request('/s/live-tok');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Minutes');
    expect(html).not.toContain('team-token-prompt');
    expect(html).not.toContain('Sign in as a member');
  });
});

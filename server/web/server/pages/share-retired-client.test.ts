/**
 * /s/<token> after the old client links were retired (client logins C3),
 * without a database. An old client link answers a plain 410 "This link has
 * ended. Ask the person who sent it for a new one." with no sign-in link
 * (the client sign-in pages went in workspaces W5c), no item title and never
 * the content; a retired team link keeps its own page; any other dead token
 * keeps the uniform 404; a live link renders.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  live: new Set<string>(),
  team: new Set<string>(),
  client: new Set<string>(),
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
  isRetiredClientLinkToken: vi.fn(async (token: string) => h.client.has(token)),
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
  h.client = new Set(['old-client-tok']);
});

const app = async () => {
  // The page as the app serves it: through the gate, with its row (A4 step 2).
  const { SHARE_PAGES } = await import('./share');
  const { gate } = await import('../middleware/gate');
  const { registerPages } = await import('../route-loader');
  const a = new Hono();
  a.use('*', gate());
  registerPages(a, SHARE_PAGES, 'link');
  return a;
};

describe('/s/<token> with client links retired', () => {
  it('tells an old client link it has ended (410, no sign-in link, no title)', async () => {
    const res = await (await app()).request('/s/old-client-tok');
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('This link has ended.');
    expect(html).toContain('Ask the person who sent it for a new one.');
    expect(html).not.toContain('client-signin');
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toContain('Sign in');
    expect(html).toContain('noindex');
    expect(html).not.toContain('Minutes');
    expect(html).not.toContain('Sign in as a member');
  });

  it('keeps the team page for a retired team link', async () => {
    const res = await (await app()).request('/s/old-team-tok');
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('Sign in as a member');
    expect(html).not.toContain('This link has ended');
  });

  it('keeps the plain 404 for any other dead token', async () => {
    const res = await (await app()).request('/s/unknown-tok');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Sign in as a client');
  });

  it('renders a live link', async () => {
    const res = await (await app()).request('/s/live-tok');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Minutes');
  });
});

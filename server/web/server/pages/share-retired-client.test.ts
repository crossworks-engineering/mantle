/**
 * /s/<token> after the old client links were retired (client logins C3),
 * without a database. An old client link answers "Sign in as a client"
 * (410) pointing at /client-signin, with no item title and never the
 * content; a retired team link keeps its own page; any other dead token
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
  const { mountShare } = await import('./share');
  const a = new Hono();
  mountShare(a);
  return a;
};

describe('/s/<token> with client links retired', () => {
  it('tells an old client link to sign in as a client (410, /client-signin, no title)', async () => {
    const res = await (await app()).request('/s/old-client-tok');
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('Sign in as a client');
    expect(html).toContain('href="/client-signin"');
    expect(html).toContain('noindex');
    expect(html).not.toContain('Minutes');
    expect(html).not.toContain('Sign in as a member');
  });

  it('keeps the team page for a retired team link', async () => {
    const res = await (await app()).request('/s/old-team-tok');
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('Sign in as a member');
    expect(html).not.toContain('Sign in as a client');
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

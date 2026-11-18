/**
 * The Sync service's screens through the brain (Sync service plan M2): the
 * screen ticket is its own kind, its login must still hold the connectors
 * area, and the answer carries a policy with no script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasArea = vi.fn(async () => true);
vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  loginHasArea: (...a: unknown[]) => hasArea(...(a as [])),
}));

import {
  buildAppFrameTicket,
  buildServiceFrameTicket,
  verifyAppFrameTicket,
  verifyServiceFrameTicket,
} from './auth/tokens';
import { serviceScreen } from './service-screens';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const LOGIN = '00000000-0000-4000-8000-0000000000b2';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 's'.repeat(48));
  vi.stubEnv('SYNC_TOKEN', 'stok');
  vi.stubEnv('SYNC_URL', 'http://sync:8099');
  vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sync');
  hasArea.mockClear();
  hasArea.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const screen = (t: string, p = '/', init?: RequestInit) =>
  serviceScreen(
    new Request(
      `http://web:3000/api/services/sync/ui?p=${encodeURIComponent(p)}&t=${encodeURIComponent(t)}`,
      init,
    ),
    'sync',
  );

describe('the screen ticket', () => {
  it('is its own kind: an app ticket is no screen ticket, nor the reverse', () => {
    const s = buildServiceFrameTicket({ ownerId: OWNER, service: 'sync', actorId: LOGIN });
    const a = buildAppFrameTicket({ ownerId: OWNER, appId: OWNER, actorId: LOGIN });
    expect(verifyServiceFrameTicket(s)).toEqual({
      ownerId: OWNER,
      service: 'sync',
      actorId: LOGIN,
    });
    expect(verifyServiceFrameTicket(a)).toBeNull();
    expect(verifyAppFrameTicket(s)).toBeNull();
  });
});

describe('serviceScreen', () => {
  it('refuses no ticket, an app ticket, and a login without the area', async () => {
    expect((await screen('')).status).toBe(401);
    expect(
      (await screen(buildAppFrameTicket({ ownerId: OWNER, appId: OWNER, actorId: LOGIN }))).status,
    ).toBe(401);
    hasArea.mockResolvedValue(false);
    const t = buildServiceFrameTicket({ ownerId: OWNER, service: 'sync', actorId: LOGIN });
    expect((await screen(t)).status).toBe(403);
    expect(hasArea).toHaveBeenCalledWith(LOGIN, 'connectors');
  });

  it('refuses a path the sidecar does not name, and answers 404 while Sync is off', async () => {
    const t = buildServiceFrameTicket({ ownerId: OWNER, service: 'sync', actorId: LOGIN });
    expect((await screen(t, '/../health')).status).toBe(404);
    vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sandboxes');
    expect((await screen(t)).status).toBe(404);
  });

  it('hands the screen to the sidecar with its token and a fresh ticket, and answers it with no script', async () => {
    const seen: { url: string; headers: Headers; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({
          url,
          headers: new Headers(init.headers),
          body: init.body as string | undefined,
        });
        return new Response('<!doctype html><p>ok</p>', {
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    const t = buildServiceFrameTicket({ ownerId: OWNER, service: 'sync', actorId: LOGIN });
    const res = await screen(t, '/mailbox/save', {
      method: 'POST',
      body: 'address=a%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<p>ok</p>');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).not.toContain('script-src');
    expect(seen[0]!.url).toBe('http://sync:8099/ui/mailbox/save');
    expect(seen[0]!.headers.get('x-mantle-sync-token')).toBe('stok');
    expect(seen[0]!.headers.get('x-mantle-ui-base')).toBe('/api/services/sync/ui');
    expect(verifyServiceFrameTicket(seen[0]!.headers.get('x-mantle-frame-ticket')!)?.actorId).toBe(
      LOGIN,
    );
    expect(seen[0]!.body).toBe('address=a%40example.com');
  });
});

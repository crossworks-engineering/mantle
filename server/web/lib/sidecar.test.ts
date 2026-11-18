/**
 * The Sync sidecar's routes take only the sidecar (Sync service plan M2):
 * its own token (not the gateway's), straight from the stack's network, and
 * nothing while Sync is off. Its state is sealed under its key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sidecarRequestRefusal } from './sidecar';
import { openState, sealState } from './sidecar-state';

const req = (headers: Record<string, string>) =>
  new Request('http://web:3000/api/sidecar/state', { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sidecarRequestRefusal', () => {
  it('takes the Sync token while Sync is on', () => {
    vi.stubEnv('SYNC_TOKEN', 'stok');
    vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sync');
    expect(sidecarRequestRefusal(req({ 'x-mantle-sync-token': 'stok' }))).toBeNull();
  });

  it("refuses a wrong token, the gateway's, and any while none is set", () => {
    vi.stubEnv('SYNC_TOKEN', 'stok');
    vi.stubEnv('GATEWAY_TOKEN', 'gtok');
    vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sync');
    expect(sidecarRequestRefusal(req({}))?.status).toBe(401);
    expect(sidecarRequestRefusal(req({ 'x-mantle-sync-token': 'nope' }))?.status).toBe(401);
    expect(sidecarRequestRefusal(req({ 'x-mantle-gateway-token': 'gtok' }))?.status).toBe(401);
    vi.stubEnv('SYNC_TOKEN', '');
    expect(sidecarRequestRefusal(req({ 'x-mantle-sync-token': '' }))?.status).toBe(401);
  });

  it('refuses the front door, and everything while Sync is off', () => {
    vi.stubEnv('SYNC_TOKEN', 'stok');
    vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sync');
    const through = req({ 'x-forwarded-for': '203.0.113.9', 'x-mantle-sync-token': 'stok' });
    expect(sidecarRequestRefusal(through)?.status).toBe(404);
    vi.stubEnv('MANTLE_COMPOSE_PROFILES', 'sandboxes');
    expect(sidecarRequestRefusal(req({ 'x-mantle-sync-token': 'stok' }))?.status).toBe(404);
  });
});

describe('the sealed state', () => {
  it('opens under its own key only', () => {
    vi.stubEnv('MANTLE_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
    const sealed = sealState('account:x', { password: 'pw' });
    expect(sealed.toString('utf8')).not.toContain('pw');
    expect(openState('account:x', sealed)).toEqual({ password: 'pw' });
    expect(() => openState('account:y', sealed)).toThrow();
  });
});

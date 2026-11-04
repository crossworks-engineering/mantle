/**
 * The gateway's own routes take only the gateway: its token, straight from
 * the stack's network (never through the front door).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayRequestRefusal } from './gateway-internal';

const req = (headers: Record<string, string>) =>
  new Request('http://web:3000/api/gateway/registry', { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gatewayRequestRefusal', () => {
  it('takes the gateway token', () => {
    vi.stubEnv('GATEWAY_TOKEN', 'tok');
    expect(gatewayRequestRefusal(req({ 'x-mantle-gateway-token': 'tok' }))).toBeNull();
  });

  it('refuses a wrong or missing token, and any token when none is set', async () => {
    vi.stubEnv('GATEWAY_TOKEN', 'tok');
    expect(gatewayRequestRefusal(req({}))?.status).toBe(401);
    expect(gatewayRequestRefusal(req({ 'x-mantle-gateway-token': 'nope' }))?.status).toBe(401);
    expect(gatewayRequestRefusal(req({ authorization: 'Bearer tok' }))?.status).toBe(401);
    vi.stubEnv('GATEWAY_TOKEN', '');
    expect(gatewayRequestRefusal(req({ 'x-mantle-gateway-token': '' }))?.status).toBe(401);
  });

  it('refuses a request that came through the front door, token or not', () => {
    vi.stubEnv('GATEWAY_TOKEN', 'tok');
    for (const h of <Array<Record<string, string>>>[
      { 'x-forwarded-for': '203.0.113.9' },
      { forwarded: 'for=203.0.113.9' },
    ]) {
      expect(gatewayRequestRefusal(req({ ...h, 'x-mantle-gateway-token': 'tok' }))?.status).toBe(
        404,
      );
    }
  });
});

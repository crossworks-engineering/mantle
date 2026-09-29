/**
 * The client sign-in limiters key an IPv6 caller by its /64 (client logins
 * audit B2): one subscriber holds a whole /64, so keying by the full
 * address gave a stranger a fresh bucket per request. The sign-in link
 * route's per-address cap, as the code routes' (client-code-routes.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

const req = (ip: string) =>
  new Request('https://brain.example.invalid/api/auth/client-link', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });

describe('clientLinkRateLimited', () => {
  it('counts a whole IPv6 /64 as one address, and another /64 apart', async () => {
    vi.resetModules();
    const { clientLinkRateLimited, CLIENT_LINK_LIMITS } = await import('./client-logins');
    for (let i = 0; i < CLIENT_LINK_LIMITS.perIp; i += 1) {
      expect(clientLinkRateLimited(req(`2001:db8:aa:1::${(i + 1).toString(16)}`))).toBeNull();
    }
    expect(clientLinkRateLimited(req('2001:db8:aa:1:ffff::1'))?.status).toBe(429);
    expect(clientLinkRateLimited(req('2001:db8:aa:2::1'))).toBeNull();
  });

  it('keeps IPv4 addresses apart', async () => {
    vi.resetModules();
    const { clientLinkRateLimited, CLIENT_LINK_LIMITS } = await import('./client-logins');
    for (let i = 0; i < CLIENT_LINK_LIMITS.perIp; i += 1) {
      expect(clientLinkRateLimited(req('198.51.100.40'))).toBeNull();
    }
    expect(clientLinkRateLimited(req('198.51.100.40'))?.status).toBe(429);
    expect(clientLinkRateLimited(req('198.51.100.41'))).toBeNull();
  });
});

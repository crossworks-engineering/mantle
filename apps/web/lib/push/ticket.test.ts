// Tests for Mantle-side enrollment-ticket minting. The wire format here MUST
// match mantle-push/src/lib/ticket.ts, which the LIVE relay uses to verify:
//   <base64url(payloadJSON)>.<base64url(HMAC-SHA256(payloadB64, sha256(token)))>
// So rather than just "it returns a string", we recompute the exact bytes an
// independent verifier (the relay) would and assert equality — a drift in
// encoding, field order, or key derivation fails here instead of in production.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintTicket } from './ticket';
import { hashToken } from './tokens';

const IID = 'relay-instance-1';
const OS_TOKEN = 'apns-device-token-xyz';
const INSTANCE_TOKEN = 'install-secret';

// Reproduce the relay's verification independently from primitives.
function relayWouldAccept(ticket: string, instanceToken: string, nowSeconds: number): boolean {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);
  const expected = createHmac('sha256', hashToken(instanceToken)).update(payloadB64).digest('base64url');
  if (sigB64 !== expected) return false;
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { exp: number };
  return nowSeconds <= payload.exp;
}

function decode(ticket: string): { iid: string; osPushToken: string; exp: number } {
  return JSON.parse(Buffer.from(ticket.split('.')[0]!, 'base64url').toString('utf8'));
}

afterEach(() => vi.useRealTimers());

describe('mintTicket', () => {
  it('emits the exact <base64url>.<base64url> bytes the relay verifies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'));
    const now = Math.floor(Date.UTC(2026, 5, 14) / 1000);

    const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN });

    const expectedPayload = Buffer.from(
      JSON.stringify({ iid: IID, osPushToken: OS_TOKEN, exp: now + 300 }),
      'utf8',
    ).toString('base64url');
    const expectedSig = createHmac('sha256', hashToken(INSTANCE_TOKEN)).update(expectedPayload).digest('base64url');
    expect(ticket).toBe(`${expectedPayload}.${expectedSig}`);
  });

  it('produces a ticket the relay would accept (key = sha256(instanceToken))', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T12:00:00Z'));
    const now = Math.floor(Date.parse('2026-06-14T12:00:00Z') / 1000);

    const ticket = mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN });
    expect(relayWouldAccept(ticket, INSTANCE_TOKEN, now)).toBe(true);
    // A different install secret must NOT verify — anti-forgery boundary.
    expect(relayWouldAccept(ticket, 'a-different-secret', now)).toBe(false);
  });

  it('defaults to a 300s TTL and honours a custom ttlSeconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'));
    const now = Math.floor(Date.UTC(2026, 5, 14) / 1000);

    expect(decode(mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN })).exp).toBe(now + 300);
    expect(
      decode(mintTicket({ iid: IID, osPushToken: OS_TOKEN, instanceToken: INSTANCE_TOKEN, ttlSeconds: 60 })).exp,
    ).toBe(now + 60);
  });

  it('binds the payload to the given iid + osPushToken', () => {
    const payload = decode(mintTicket({ iid: 'iid-2', osPushToken: 'tok-2', instanceToken: INSTANCE_TOKEN }));
    expect(payload.iid).toBe('iid-2');
    expect(payload.osPushToken).toBe('tok-2');
  });
});

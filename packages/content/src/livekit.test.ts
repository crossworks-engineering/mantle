/**
 * The brain's door to LiveKit (calls plan page 886126b4, sections 11, 13
 * and 20), with no server: the token's claims are exactly the plan's, the
 * ICE override carries the room's credential pair on the ports LiveKit
 * listens on, the identities round-trip, the capabilities follow the
 * switch, and a webhook body with a wrong signature is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';
import {
  CALL_TOKEN_TTL_S,
  callCapabilities,
  callIceServers,
  callsHost,
  callsServiceOn,
  identityAgentId,
  identityLoginId,
  livekitHttpUrl,
  livekitPublicUrl,
  loginIdentity,
  mintCallToken,
  signLivekitWebhookForTests,
  verifyLivekitWebhook,
} from './livekit';

const KEY = 'APItestkey';
const SECRET = 'a-secret-long-enough-for-the-sdk-to-accept-it';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const ROOM = `msgr-${'11111111-1111-4111-8111-111111111111'}`;

const ENV = [
  'MANTLE_LIVEKIT_API_KEY',
  'MANTLE_LIVEKIT_API_SECRET',
  'MANTLE_LIVEKIT_URL',
  'MANTLE_LIVEKIT_PUBLIC_URL',
  'MANTLE_CALLS_HOST',
  'MANTLE_CALLS_AGENT',
  'MANTLE_COMPOSE_PROFILES',
  'MANTLE_UPDATE_SIGNAL_DIR',
] as const;
const saved: Record<string, string | undefined> = {};

function decode(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  for (const n of ENV) saved[n] = process.env[n];
  process.env.MANTLE_LIVEKIT_API_KEY = KEY;
  process.env.MANTLE_LIVEKIT_API_SECRET = SECRET;
  process.env.MANTLE_CALLS_HOST = 'brain.example.test';
  // No services.json on the Mac: the profile decides through compose's env.
  process.env.MANTLE_UPDATE_SIGNAL_DIR = '/nonexistent-signal-dir';
  process.env.MANTLE_COMPOSE_PROFILES = 'calls';
  // Compose always hands the app the service URL (x-app-env); "on" needs it
  // as the sandboxes need SANDBOXD_URL.
  process.env.MANTLE_LIVEKIT_URL = 'ws://livekit:7880';
  delete process.env.MANTLE_LIVEKIT_PUBLIC_URL;
  delete process.env.MANTLE_CALLS_AGENT;
});
afterEach(() => {
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('the call token (section 11)', () => {
  it('carries exactly: the identity, the name, one room, join, publish the microphone, subscribe, data; one hour; no admin grant', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = await mintCallToken({
      identity: loginIdentity(LOGIN),
      name: 'Pat',
      room: ROOM,
    });
    const claims = decode(token);
    expect(claims.sub).toBe(`login:${LOGIN}`);
    expect(claims.name).toBe('Pat');
    expect(claims.iss).toBe(KEY);
    expect(claims.video).toEqual({
      room: ROOM,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: ['microphone'],
    });
    // Nothing else: no roomAdmin, roomCreate, roomRecord, roomList, ingress,
    // agent or hidden grants anywhere in the token.
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iss', 'name', 'nbf', 'sub', 'video']);
    expect(Object.keys(claims.video as object)).not.toContain('roomAdmin');
    const exp = claims.exp as number;
    expect(exp - before).toBeGreaterThanOrEqual(CALL_TOKEN_TTL_S - 2);
    expect(exp - before).toBeLessThanOrEqual(CALL_TOKEN_TTL_S + 2);
    expect(CALL_TOKEN_TTL_S).toBe(3600);
    expect(Math.abs(new Date(expiresAt).getTime() - exp * 1000)).toBeLessThan(3000);
    // The SDK itself reads the token back with the same grant.
    const back = await new AccessToken(KEY, SECRET).toJwt();
    expect(decode(back).iss).toBe(KEY);
  });

  it('refuses to mint without the key pair', async () => {
    delete process.env.MANTLE_LIVEKIT_API_SECRET;
    await expect(
      mintCallToken({ identity: loginIdentity(LOGIN), name: 'Pat', room: ROOM }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('the ICE override (section 20)', () => {
  it('hands the room its own TURN credential pair on 5349 (TLS) and 3478 (UDP) at the calls host', () => {
    expect(callIceServers(ROOM, 'turn-pass')).toEqual({
      urls: [
        'turns:brain.example.test:5349?transport=tcp',
        'turn:brain.example.test:3478?transport=udp',
      ],
      username: ROOM,
      credential: 'turn-pass',
    });
  });

  it("is null without a calls host or a TURN password (the client keeps LiveKit's list)", () => {
    expect(callIceServers(ROOM, null)).toBeNull();
    delete process.env.MANTLE_CALLS_HOST;
    expect(callsHost()).toBeNull();
    expect(callIceServers(ROOM, 'turn-pass')).toBeNull();
  });

  it('reads the host as a bare name, whatever was written', () => {
    process.env.MANTLE_CALLS_HOST = ' https://brain.example.test/ ';
    expect(callsHost()).toBe('brain.example.test');
  });
});

describe('urls and identities', () => {
  it('the SDK base is MANTLE_LIVEKIT_URL as http; the public URL is wss://<host>/livekit unless set', () => {
    expect(livekitHttpUrl()).toBe('http://livekit:7880');
    delete process.env.MANTLE_LIVEKIT_URL;
    expect(livekitHttpUrl()).toBe('http://livekit:7880');
    process.env.MANTLE_LIVEKIT_URL = 'wss://lk.internal:7880/';
    expect(livekitHttpUrl()).toBe('https://lk.internal:7880');
    expect(livekitPublicUrl()).toBe('wss://brain.example.test/livekit');
    process.env.MANTLE_LIVEKIT_PUBLIC_URL = 'wss://other.example.test/livekit/';
    expect(livekitPublicUrl()).toBe('wss://other.example.test/livekit');
  });

  it('login:<id> and agent:<id> round-trip, anything else is nobody', () => {
    expect(identityLoginId(loginIdentity(LOGIN.toUpperCase()))).toBe(LOGIN);
    expect(identityAgentId(`agent:${LOGIN}`)).toBe(LOGIN);
    expect(identityLoginId(`agent:${LOGIN}`)).toBeNull();
    expect(identityLoginId('login:not-a-uuid')).toBeNull();
    expect(identityLoginId('')).toBeNull();
    expect(identityAgentId('mantle-voice')).toBeNull();
  });
});

describe('the switch (sections 4 and 9)', () => {
  it('calls are on with the profile and the keys; the agent needs its flag too; video never', () => {
    expect(callsServiceOn()).toBe(true);
    expect(callCapabilities()).toEqual({ calls: true, callsAgent: false, video: false });
    process.env.MANTLE_CALLS_AGENT = '1';
    expect(callCapabilities()).toEqual({ calls: true, callsAgent: true, video: false });
    process.env.MANTLE_COMPOSE_PROFILES = 'sandboxes';
    expect(callsServiceOn()).toBe(false);
    expect(callCapabilities()).toEqual({ calls: false, callsAgent: false, video: false });
    process.env.MANTLE_COMPOSE_PROFILES = 'calls';
    delete process.env.MANTLE_LIVEKIT_API_SECRET;
    expect(callsServiceOn()).toBe(false);
  });
});

describe('the webhook verifier (section 11)', () => {
  const body = JSON.stringify({
    event: 'room_finished',
    id: 'EV_1',
    room: { name: ROOM, sid: 'RM_1' },
    createdAt: 1700000000,
  });

  const sign = (secret: string, forBody: string) =>
    signLivekitWebhookForTests(forBody, secret, KEY);

  it('accepts a body signed with the secret and reads the event', async () => {
    const ev = await verifyLivekitWebhook(body, await sign(SECRET, body));
    expect(ev).toEqual({
      id: 'EV_1',
      event: 'room_finished',
      roomName: ROOM,
      participant: null,
      createdAt: 1700000000,
    });
  });

  it('refuses a wrong secret, a tampered body, a missing header and a non-event', async () => {
    const other = 'another-secret-long-enough-for-the-sdk-to-take';
    await expect(verifyLivekitWebhook(body, await sign(other, body))).rejects.toThrow();
    const tampered = body.replace('EV_1', 'EV_2');
    await expect(verifyLivekitWebhook(tampered, await sign(SECRET, body))).rejects.toThrow();
    await expect(verifyLivekitWebhook(body, null)).rejects.toThrow();
    await expect(verifyLivekitWebhook(body, 'Bearer nope')).rejects.toThrow();
    const notEvent = '{"hello":"world"}';
    await expect(verifyLivekitWebhook(notEvent, await sign(SECRET, notEvent))).rejects.toThrow();
  });
});

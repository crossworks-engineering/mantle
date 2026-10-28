/**
 * The brain's one door to LiveKit (calls plan page 886126b4, sections 3,
 * 4, 9 and 11): the token mint, the room admin client and the webhook
 * verifier of livekit-server-sdk, behind a small interface so the call
 * store (messenger-calls.ts) and its tests never touch the SDK.
 *
 *  - The API key and secret come from the environment and never leave this
 *    process: a token is minted here, a room is read, closed or emptied
 *    here, a webhook is verified here. Nothing else imports the SDK.
 *  - A token names one login, one room and what it may do: join, publish
 *    its microphone, subscribe, send data; never an admin grant. One hour.
 *  - The ICE override (section 20): LiveKit tells browsers to use TURN/TLS
 *    on port 443, which Caddy holds. The brain hands the client the same
 *    TURN credential pair LiveKit minted for the room (the room's name and
 *    its TURN password, read from the room API) with the port LiveKit
 *    really listens on (5349), and the TURN/UDP server beside it.
 *  - "Calls are on" is the Settings > Services switch (@mantle/config
 *    serviceEnabled('calls')): the compose profile plus the wiring.
 */
import { createHash } from 'node:crypto';
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { env, envFlag, envNumber, serviceEnabled } from '@mantle/config';
import { NET_TIMEOUTS, withTimeout } from '@mantle/std';

/** A call token lives one hour; the client refreshes before that. */
export const CALL_TOKEN_TTL_S = 3600;
/** The room closes this long after the last person leaves. */
export const CALL_ROOM_EMPTY_TIMEOUT_S = 30;
/** TURN/TLS listens here (infra/livekit/livekit.yaml turn.tls_port). */
export const CALL_TURN_TLS_PORT = 5349;
/** TURN/UDP and STUN listen here (turn.udp_port). */
export const CALL_TURN_UDP_PORT = 3478;
/** Limits (section 12), from the environment with the plan's defaults. */
export const CALLS_MAX_MINUTES = () => envNumber('MANTLE_CALLS_MAX_MINUTES', 240, { min: 1 });
export const CALLS_MAX_PARTICIPANTS = () =>
  envNumber('MANTLE_CALLS_MAX_PARTICIPANTS', 25, { min: 2 });

/** One LiveKit API call waits this long. */
const API_TIMEOUT_MS = 8_000;

export type LivekitRoomInfo = {
  name: string;
  sid: string;
  /** The room's TURN password (the credential of the ICE override); null
   *  when TURN is off in livekit.yaml. */
  turnPassword: string | null;
  numParticipants: number;
};

export type LivekitParticipantInfo = {
  identity: string;
  name: string;
  /** Unix seconds, or null when LiveKit did not say. */
  joinedAt: number | null;
};

/** What the call store needs of LiveKit; the real one wraps the SDK, a test
 *  hands in a fake (setLivekitClientForTests). */
export type LivekitClient = {
  /** The room, made if it was not there (LiveKit's create is idempotent:
   *  an existing room comes back as it is, same sid, same TURN password). */
  ensureRoom(
    name: string,
    opts: { emptyTimeoutS: number; maxParticipants: number },
  ): Promise<LivekitRoomInfo>;
  /** The room, or null when LiveKit has none by that name. */
  getRoom(name: string): Promise<LivekitRoomInfo | null>;
  /** Who is in the room, or null when the room is gone. */
  listParticipants(name: string): Promise<LivekitParticipantInfo[] | null>;
  /** Drop one identity from the room; a missing room or identity is fine. */
  removeParticipant(name: string, identity: string): Promise<void>;
  /** Close the room, dropping everyone; a missing room is fine. */
  deleteRoom(name: string): Promise<void>;
};

/** Thrown when LiveKit did not answer (down, or the keys refused). */
export class LivekitUnavailableError extends Error {
  constructor(message = 'The calls service did not answer.') {
    super(message);
    this.name = 'LivekitUnavailableError';
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown; status?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  return code === 'not_found' || status === 404;
}

/** MANTLE_LIVEKIT_URL as the SDK's HTTP base (ws:// to http://). */
export function livekitHttpUrl(): string {
  const raw = env('MANTLE_LIVEKIT_URL') || 'ws://livekit:7880';
  return raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

/** The signalling URL the client connects to: wss://<site>/livekit behind
 *  Caddy (section 4), or what the box says. */
export function livekitPublicUrl(): string | null {
  const set = env('MANTLE_LIVEKIT_PUBLIC_URL');
  if (set) return set.replace(/\/+$/, '');
  const host = callsHost();
  return host ? `wss://${host}/livekit` : null;
}

/** The one hostname TURN and the ICE override use: MANTLE_CALLS_HOST,
 *  which install.sh and the updater write from the first address of
 *  MANTLE_SITE_ADDRESS (compose reads that one; the app never does). Null
 *  until a box has it: no ICE override, LiveKit's own list then. */
export function callsHost(): string | null {
  const set = env('MANTLE_CALLS_HOST')
    ?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return set || null;
}

/** The key and secret are both set: the brain can mint and verify. */
export function livekitConfigured(): boolean {
  return Boolean(env('MANTLE_LIVEKIT_API_KEY') && env('MANTLE_LIVEKIT_API_SECRET'));
}

/** Calls are on for this brain: the Settings > Services switch (the
 *  `calls` profile plus the wiring) and the keys. */
export function callsServiceOn(): boolean {
  return serviceEnabled('calls') && livekitConfigured();
}

/** The agent worker is registered for this box (MANTLE_CALLS_AGENT): the
 *  assistant-call routes answer only then. No worker ships in P1. */
export function callsAgentOn(): boolean {
  return callsServiceOn() && envFlag('MANTLE_CALLS_AGENT', false);
}

/** GET /api/messenger/capabilities (section 9). */
export function callCapabilities(): { calls: boolean; callsAgent: boolean; video: false } {
  const calls = callsServiceOn();
  return { calls, callsAgent: calls && callsAgentOn(), video: false };
}

function keys(): { key: string; secret: string } {
  const key = env('MANTLE_LIVEKIT_API_KEY');
  const secret = env('MANTLE_LIVEKIT_API_SECRET');
  if (!key || !secret) throw new LivekitUnavailableError('The calls service is not configured.');
  return { key, secret };
}

/** The claims a call token carries, exactly (section 11): pinned by the
 *  token test, read by nothing else. */
export type CallTokenClaims = {
  identity: string;
  name: string;
  room: string;
};

/** A one-hour token for one identity in one room: join, publish the
 *  microphone, subscribe, send data. No admin grant of any kind. */
export async function mintCallToken(
  claims: CallTokenClaims,
): Promise<{ token: string; expiresAt: string }> {
  const { key, secret } = keys();
  const at = new AccessToken(key, secret, {
    identity: claims.identity,
    name: claims.name,
    ttl: CALL_TOKEN_TTL_S,
  });
  at.addGrant({
    room: claims.room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  const token = await at.toJwt();
  return { token, expiresAt: new Date(Date.now() + CALL_TOKEN_TTL_S * 1000).toISOString() };
}

/** The ICE override (section 20): TURN/TLS on 5349 and TURN/UDP on 3478 at
 *  the calls host, with the room's own credential pair (LiveKit's TURN
 *  user name is the room's name, its password the room's TURN password).
 *  Null when the box has no calls host or the room no TURN password. */
export function callIceServers(
  roomName: string,
  turnPassword: string | null,
): { urls: string[]; username: string; credential: string } | null {
  const host = callsHost();
  if (!host || !turnPassword) return null;
  return {
    urls: [
      `turns:${host}:${CALL_TURN_TLS_PORT}?transport=tcp`,
      `turn:${host}:${CALL_TURN_UDP_PORT}?transport=udp`,
    ],
    username: roomName,
    credential: turnPassword,
  };
}

/** The identity a login joins as (section 11). */
export function loginIdentity(loginId: string): string {
  return `login:${loginId.toLowerCase()}`;
}

/** The login id of a `login:<id>` identity, or null for any other. */
export function identityLoginId(identity: string): string | null {
  const m = /^login:([0-9a-f-]{36})$/i.exec(identity);
  return m ? m[1]!.toLowerCase() : null;
}

/** The agent id of an `agent:<id>` identity, or null for any other. */
export function identityAgentId(identity: string): string | null {
  const m = /^agent:([0-9a-f-]{36})$/i.exec(identity);
  return m ? m[1]!.toLowerCase() : null;
}

// ── The room admin client ────────────────────────────────────────────────────

function roomInfo(r: {
  name: string;
  sid: string;
  turnPassword: string;
  numParticipants: number;
}): LivekitRoomInfo {
  return {
    name: r.name,
    sid: r.sid,
    turnPassword: r.turnPassword || null,
    numParticipants: r.numParticipants,
  };
}

function sdkClient(): LivekitClient {
  const { key, secret } = keys();
  const svc = new RoomServiceClient(livekitHttpUrl(), key, secret);
  const call = <T>(label: string, p: Promise<T>) => withTimeout(p, API_TIMEOUT_MS, label);
  const unavailable = (err: unknown): never => {
    throw new LivekitUnavailableError(
      `The calls service did not answer (${err instanceof Error ? err.name : 'error'}).`,
    );
  };
  return {
    async ensureRoom(name, opts) {
      try {
        const r = await call(
          'livekit createRoom',
          svc.createRoom({
            name,
            emptyTimeout: opts.emptyTimeoutS,
            maxParticipants: opts.maxParticipants,
          }),
        );
        return roomInfo(r);
      } catch (err) {
        return unavailable(err);
      }
    },
    async getRoom(name) {
      try {
        const rooms = await call('livekit listRooms', svc.listRooms([name]));
        const r = rooms.find((x) => x.name === name);
        return r ? roomInfo(r) : null;
      } catch (err) {
        return unavailable(err);
      }
    },
    async listParticipants(name) {
      try {
        const list = await call('livekit listParticipants', svc.listParticipants(name));
        return list.map((p) => ({
          identity: p.identity,
          name: p.name,
          joinedAt: p.joinedAt ? Number(p.joinedAt) : null,
        }));
      } catch (err) {
        if (isNotFound(err)) return null;
        return unavailable(err);
      }
    },
    async removeParticipant(name, identity) {
      try {
        await call('livekit removeParticipant', svc.removeParticipant(name, identity));
      } catch (err) {
        if (isNotFound(err)) return;
        unavailable(err);
      }
    },
    async deleteRoom(name) {
      try {
        await call('livekit deleteRoom', svc.deleteRoom(name));
      } catch (err) {
        if (isNotFound(err)) return;
        unavailable(err);
      }
    },
  };
}

let testClient: LivekitClient | null = null;

/** The room admin client: the SDK's, or the fake a test handed in. */
export function livekitClient(): LivekitClient {
  return testClient ?? sdkClient();
}

/** Tests only: stand in for LiveKit (null puts the SDK back). */
export function setLivekitClientForTests(client: LivekitClient | null): void {
  testClient = client;
}

// ── The webhook ──────────────────────────────────────────────────────────────

/** A LiveKit webhook as the call store reads it: the event's id (the
 *  replay guard), its kind, the room and the participant it names. */
export type LivekitWebhook = {
  id: string;
  event: string;
  roomName: string | null;
  participant: { identity: string; name: string } | null;
  /** Unix seconds, or null. */
  createdAt: number | null;
};

/** Verify a webhook delivery on its RAW body and the Authorization header
 *  (a JWT signed with the API secret that carries the body's sha256), as
 *  LiveKit's WebhookReceiver does. Throws on any failure: a bad signature,
 *  a tampered body, a body that is not an event. Never logs the body. */
export async function verifyLivekitWebhook(
  rawBody: string,
  authorization: string | null,
): Promise<LivekitWebhook> {
  const { key, secret } = keys();
  if (!authorization) throw new Error('no Authorization header');
  const receiver = new WebhookReceiver(key, secret);
  const ev: WebhookEvent = await receiver.receive(rawBody, authorization);
  if (!ev.id || !ev.event) throw new Error('not a webhook event');
  return {
    id: String(ev.id),
    event: String(ev.event),
    roomName: ev.room?.name || null,
    participant: ev.participant
      ? { identity: ev.participant.identity, name: ev.participant.name }
      : null,
    createdAt: ev.createdAt ? Number(ev.createdAt) : null,
  };
}

/** Tests only: the Authorization header LiveKit would send for `body`
 *  (a JWT signed with `secret` carrying the body's sha256), so a route test
 *  outside this package needs no SDK of its own. */
export async function signLivekitWebhookForTests(
  body: string,
  secret: string = env('MANTLE_LIVEKIT_API_SECRET') ?? '',
  key: string = env('MANTLE_LIVEKIT_API_KEY') ?? '',
): Promise<string> {
  const at = new AccessToken(key, secret, { ttl: 60 });
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

/** The LiveKit HTTP port answers (the Settings > Services probe). The
 *  server answers its root with 200 "OK". */
export async function livekitHealth(
  timeoutMs: number = NET_TIMEOUTS.localProbe,
): Promise<{ up: boolean }> {
  try {
    const res = await withTimeout(
      fetch(`${livekitHttpUrl()}/`, { method: 'GET', redirect: 'manual' }),
      timeoutMs,
      'livekit health',
    );
    return { up: res.ok };
  } catch {
    return { up: false };
  }
}

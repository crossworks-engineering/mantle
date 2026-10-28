/**
 * Calls between people (calls plan page 886126b4, sections 5, 8, 9 and 20):
 * a call is a LiveKit room named after a messenger conversation. The routes
 * live under /api/messenger; the brain mints every token and never hands
 * out an admin grant. The system lines that mark a call ride the message
 * stream (MessengerMessage.event, dto/messenger.ts).
 */

/** GET /api/messenger/capabilities, cached a minute client-side. */
export type MessengerCapabilities = {
  /** The Calls service is on for this brain: show the Call button. */
  calls: boolean;
  /** The agent worker is registered on this box (P2): show the assistant
   *  row's Call button only then. */
  callsAgent: boolean;
  /** Always false in P1. */
  video: false;
};

/**
 * The ICE override of section 20. LiveKit tells a browser to reach its
 * TURN/TLS server on port 443, which Caddy holds; the brain hands the client
 * the same credential pair with the port LiveKit really listens on. The
 * client passes this as `rtcConfig.iceServers` (and nothing else) when it
 * connects; `username` is the room's name and `credential` the room's TURN
 * password, as LiveKit minted them. Null when the box has no calls host or
 * TURN is off: connect with LiveKit's own list then.
 */
export type MessengerCallIce = {
  /** turns:<host>:5349?transport=tcp first, then turn:<host>:3478?transport=udp. */
  urls: string[];
  username: string;
  credential: string;
};

/** POST /api/messenger/c/:id/call, .../call/token, and the assistant twins
 *  POST /api/assistant/:agentId/call, .../call/token. */
export type MessengerCallJoinResponse = {
  /** The call row (GET .../calls); null for a call with your own assistant,
   *  which has no row. */
  callId: string | null;
  /** The LiveKit room: msgr-<conversationId>, or asst-<agentId>-<loginId>. */
  room: string;
  /** The signalling URL (wss://<site>/livekit behind Caddy). */
  url: string;
  /** A one-hour JWT for this login in this room: join, publish the
   *  microphone, subscribe, send data. Refresh before `expiresAt`. */
  token: string;
  expiresAt: string;
  ice: MessengerCallIce | null;
};

/** POST .../call and the assistant twin take this body. */
export type MessengerCallStartRequest = {
  /** What this client is ("web", "desktop", "phone"), at most 32 chars. */
  device?: string | null;
};

export type MessengerCallEndedReason =
  'finished' | 'cap_reached' | 'closed_by_admin' | 'service_off' | 'reconciled';

export type MessengerCallParticipant = {
  kind: 'login' | 'agent';
  /** The login id or the agent id. */
  id: string;
  joinedAt: string;
  /** Null while the stay is open. */
  leftAt: string | null;
  device: string | null;
};

/** One call of a conversation. */
export type MessengerCall = {
  id: string;
  conversationId: string;
  kind: 'audio' | 'video';
  /** The login that tapped Call, or null once that login is gone. */
  startedBy: string | null;
  /** The seq of its "call started" line. */
  startedSeq: number;
  startedAt: string;
  /** Null while the call is open. */
  endedAt: string | null;
  endedReason: MessengerCallEndedReason | null;
  durationS: number | null;
  /** The most people in it at once. */
  maxParticipants: number;
  participants: MessengerCallParticipant[];
};

/** GET /api/messenger/c/:id/calls?before=<ISO>&limit=: newest first. */
export type MessengerCallsResponse = {
  calls: MessengerCall[];
  /** Older calls exist before the last one returned. */
  hasMore: boolean;
};

// Enrollment ticket minting (Mantle side). A short-lived, instance-signed grant
// that lets the app enroll a device with the relay WITHOUT ever holding the
// long-lived instance token (push-notifications.md §5.1).
//
// Wire format MUST match mantle-push/src/lib/ticket.ts (the relay verifies it):
//   <base64url(payloadJSON)>.<base64url(hmac)>
//   payload = { iid, osPushToken, exp }   (exp = unix seconds)
//   hmac    = HMAC-SHA256( payloadB64, key = sha256(instanceToken) )

import { createHmac } from 'node:crypto';
import { hashToken } from './tokens';

const DEFAULT_TTL_SECONDS = 300; // ~5 min

export interface TicketPayload {
  iid: string;
  osPushToken: string;
  exp: number;
}

/**
 * Mint an enrollment ticket. `iid` is the relay's instance id (from POST
 * /instances); `instanceToken` is this install's raw secret.
 */
export function mintTicket(args: {
  iid: string;
  osPushToken: string;
  instanceToken: string;
  ttlSeconds?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: TicketPayload = { iid: args.iid, osPushToken: args.osPushToken, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', hashToken(args.instanceToken))
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

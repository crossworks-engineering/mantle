// Mantle-side instance token. The 256-bit secret that authenticates this
// install to Mantle Push. Generated here, held only by Mantle (encrypted at
// rest), never on a device. Wire-compatible with mantle-push/src/lib/tokens.ts.

import { createHash, randomBytes } from 'node:crypto';

/** A fresh 256-bit secret, URL-safe. */
export function generateInstanceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256(token) as raw bytes — the relay stores this; it's also the ticket key. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

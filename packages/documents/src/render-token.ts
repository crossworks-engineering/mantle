import { signClaims } from '@mantle/crypto';

/**
 * The render cookie (kind 'r'): the credential a render sidecar carries when
 * it loads one of this app's render surfaces. Minted here, so the documents
 * engine's node prints (packages/documents) and the browser sidecar's
 * (server/web/lib/render-pdf.ts) are one cookie; verified in the web tier
 * only (lib/auth/tokens.ts verifyRenderToken), which re-reads the login:
 * the cookie opens the one node it names, for an Admin login, and is never
 * a session. The sidecar sends it to the print origin alone.
 */
export const RENDER_COOKIE_NAME = 'mantle_render';

/** One render; bounds a leaked value. */
export const RENDER_TOKEN_TTL_SECONDS = 300;

/** Mint a render cookie VALUE. Never sent to a client. */
export function buildRenderToken(opts: {
  ownerId: string;
  actorId: string;
  nodeId: string;
  ttlSeconds?: number;
}): string {
  return signClaims(
    { uid: opts.ownerId, act: opts.actorId, n: opts.nodeId, k: 'r' },
    opts.ttlSeconds ?? RENDER_TOKEN_TTL_SECONDS,
  ).value;
}

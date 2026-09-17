/**
 * Serving an AGENT-PRODUCED picture to a member.
 *
 * `show_image` builds a ToolArtifact pointing at a file NODE; the turn runner
 * writes that node reference onto the message row's `attachments`. The owner
 * strip then loads the bytes from `/api/files/files/<nodeId>` — a route a team
 * token cannot reach, and must not be widened to, because it answers for every
 * file in the brain.
 *
 * So the member surfaces get their own door, and the authorization question is
 * asked of the MESSAGES rather than of the file tree: "is this node attached to
 * something this member can already read?" not "does the responder have access
 * to this file". The caller supplies that check; this module owns everything
 * after it — the bytes, the headers and the uniform 404.
 *
 * Modelled on `/api/team/forum/attachments/[blobId]`: same caller resolution,
 * same per-contact rate limit, same `safeDownloadHeaders` (stored-XSS defence),
 * and the same rule that a refusal is indistinguishable from a miss, so node
 * ids cannot be probed.
 */
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { getDrawSvg, recordTeamAccess } from '@mantle/content';
import { readFileById } from '@mantle/files';
import { UUID_RE } from '@mantle/std';

/** Absent, forbidden and malformed all answer the same. */
export function mediaNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export type TeamMediaCaller = { ownerId: string; contactId: string };

/**
 * Resolve + rate-limit the member, and validate the node id. Returns a Response
 * to return as-is, or the caller on success.
 */
export async function gateTeamMedia(
  req: Request,
  nodeId: string,
  surface: string,
): Promise<Response | TeamMediaCaller> {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return new Response('Unauthorized', { status: 401 });
  const { ownerId, contactId } = caller;

  if (!UUID_RE.test(nodeId)) return mediaNotFound();

  const gate = rateLimit(`team-media:${contactId}`, { max: 240, windowMs: 60_000 });
  if (!gate.ok) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'rate_limit', surface, nodeId },
    });
    return new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': String(gate.retryAfterSec), 'cache-control': 'no-store' },
    });
  }
  return { ownerId, contactId };
}

/**
 * Stream an authorized file node. IMAGES ONLY — this door exists for pictures
 * the reply placed, and a member-facing route that will hand over any mime the
 * responder attached is a wider hole than the one being closed. A non-image
 * node answers 404 like everything else refused here.
 */
export async function serveTeamMedia(ownerId: string, nodeId: string): Promise<Response> {
  const filed = await readFileById({ ownerId, fileId: nodeId });
  if (!filed) return mediaNotFound();

  const { mimeType, filename } = filed.row;
  if (!mimeType.startsWith('image/')) return mediaNotFound();

  return new Response(new Uint8Array(filed.bytes), {
    status: 200,
    headers: {
      ...safeDownloadHeaders(mimeType, filename),
      // Private and short-lived: the owner can unshare or delete at any time,
      // and revocation has to bite on the next request.
      'cache-control': 'private, max-age=300',
    },
  });
}

/**
 * Stream an authorized DRAWING's committed SVG snapshot.
 *
 * The sibling of `serveTeamMedia`, and separate from it because that one serves
 * file bytes and refuses any mime that is not an image — which a draw node is
 * not. Same door, same gate, different thing behind it.
 *
 * ⚠ The headers are the security, and they live HERE rather than in the two
 * routes so the forum's copy and Team Chat's cannot drift apart. An SVG is
 * markup: served as an image and referenced with `<img>` it is a separate,
 * script-disabled document, but this URL can also be opened directly, and as a
 * top-level document it would run its own scripts. `sandbox` with no
 * `allow-scripts` plus a null `default-src` makes that case inert too.
 * `acceptSceneSvg` still validates at commit — the point of both layers is that
 * neither is load-bearing alone. Copied deliberately from
 * `/s/[token]/draw/route.ts`; if one changes, change both.
 */
export async function serveTeamDrawing(ownerId: string, nodeId: string): Promise<Response> {
  // Filters ownerId + type, so a node attached to a readable post that is not
  // actually a drawing falls through to the same 404 as everything refused.
  const svg = await getDrawSvg(ownerId, nodeId);
  if (!svg) return mediaNotFound();

  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      // Private and short-lived: the owner can delete at any time, and
      // revocation has to bite on the next request.
      'cache-control': 'private, max-age=300',
    },
  });
}

/**
 * The double-render rule.
 *
 * A reply can place a stored picture itself by writing `![alt](media:<id>)`
 * where it belongs. That is what lets a walkthrough put each screenshot under
 * its own step (client/web/lib/rich-markdown.ts resolves the marker). Separately,
 * `show_image` returns a `ToolArtifact` which is persisted onto the turn and
 * rendered as a strip BELOW the whole reply.
 *
 * A turn that does both for the same file shows that picture twice: once in the
 * sentence it belongs to, once again underneath. The reply's own placement wins.
 *
 * Deduped mechanically rather than by prompt, because a model calling both is
 * precisely the case a prompt fails to cover, and here it costs one set
 * lookup. Telegram is unaffected: `show_image` sent its photo during the tool
 * call, long before a turn is finalized.
 */
import { inlineMediaImageIds } from '@mantle/content-core/markdown-refs';
import type { ConversationAttachment } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';

/**
 * Artifacts that still deserve a slot below the reply: every one the reply did
 * NOT already place inline. Non-image artifacts (audio, generated files) are
 * never suppressed: markdown has no way to place those, so there is no copy to
 * be a duplicate of.
 */
export function artifactsNotPlacedInline<T extends Pick<ToolArtifact, 'kind' | 'nodeId'>>(
  artifacts: readonly T[],
  replyText: string,
): T[] {
  const placed = inlineMediaImageIds(replyText);
  if (placed.size === 0) return [...artifacts];
  return artifacts.filter(
    (a) => !(a.kind === 'image' && typeof a.nodeId === 'string' && placed.has(a.nodeId)),
  );
}

/**
 * The row's `attachments` column, from a turn's artifacts and its reply text.
 *
 * Every surface that persists a turn needs the identical three steps — drop
 * what the reply already placed inline, keep only what has a node to point at,
 * and carry the reference WITHOUT the bytes. Written once here because the
 * owner turn, Team Chat and the Forum each learned it separately, and the two
 * member surfaces had learned it as "not at all": `show_image` built good
 * artifacts and they landed in an empty column.
 *
 * The nodeId filter is load-bearing, not defensive. An artifact without one has
 * nothing a client could fetch — the bytes live only on the live channel — so a
 * row written for it would render as a permanently broken picture.
 */
export function durableAttachmentsFor(
  artifacts: readonly ToolArtifact[],
  replyText: string,
): ConversationAttachment[] {
  return artifactsNotPlacedInline(artifacts, replyText)
    .filter((a) => typeof a.nodeId === 'string' && a.nodeId.length > 0)
    .map((a) => ({
      kind: a.kind,
      nodeId: a.nodeId!,
      ...(a.mimeType ? { mime: a.mimeType } : {}),
      ...(a.caption ? { caption: a.caption } : {}),
    }));
}

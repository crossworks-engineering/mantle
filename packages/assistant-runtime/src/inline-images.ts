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
import { inlineMediaImageIds } from '@mantle/content/markdown-refs';
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

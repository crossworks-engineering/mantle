/**
 * Extractor: a Present canvas's picture in its one pass (Journal v3, J9).
 *
 * A canvas is mostly drawing: its words alone summarise to little. So the
 * extractor's own single pass over a canvas may see its picture, but only
 * through a vision-capable route: when the owner has a `vision` worker
 * wired, that ONE call goes to it, with the extractor's prompt, the canvas
 * text and the picture. Otherwise the pass is the usual text call. A picture
 * is never sent to a text model, and never a second call.
 *
 * Cost: called from runExtractorModel, after every gate of the extract job
 * (admitForExtraction) has allowed the call. The vision route is resolved
 * before the picture is fetched or drawn, so a brain with no vision worker
 * never renders one.
 */
import type { AiWorker, ExtractorParams, nodes } from '@mantle/db';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { getVisionAdapter } from '@mantle/voice';
import { getPresent } from '@mantle/content/presents';
import { runVisionWorker } from '@mantle/runtime/agent';

/** A picture past this is not sent (a provider's per-image limit). */
export const PRESENT_PICTURE_MAX_BYTES = 3_500_000;

/** The reply's ceiling when the extractor worker sets none (max_tokens). */
export const EXTRACT_WITH_PICTURE_MAX_TOKENS = 8000;

/** What the canvas's one pass sees beside its text. */
export type PresentPicture = { png: Buffer; mime: 'image/png' | 'image/jpeg' };

/**
 * The picture for a canvas's pass, or null: not a canvas, no vision worker
 * wired, no picture (no current poster and no renderer in this process), or
 * one too large. Fetched (or drawn) only once the vision route is known.
 */
export async function presentPictureForPass(
  node: Pick<typeof nodes.$inferSelect, 'id' | 'type'>,
  ownerId: string,
): Promise<PresentPicture | null> {
  if (node.type !== 'present') return null;
  const route = await resolveDefaultWorker(
    ownerId,
    'vision',
    (w: AiWorker) => getVisionAdapter(w.provider) !== null,
  );
  if (!route.ok) return null;
  const p = await getPresent(ownerId, node.id);
  if (!p) return null;
  // The canvas renderer lives with the tools (registered in this process by
  // main.ts); loaded here only, so the extractor's other paths never load it.
  const { latestCanvasPicture } = await import('@mantle/tools');
  const pic = await latestCanvasPicture(ownerId, p);
  return pic && pic.png.length <= PRESENT_PICTURE_MAX_BYTES ? pic : null;
}

/**
 * The canvas's one extractor call through the vision worker: the
 * extractor's system prompt, its user payload (the fenced canvas text) and
 * the picture. Returns the reply text and the model that wrote it. A failed
 * call throws, as the extractor's text call does (chatComplete).
 */
export async function extractWithPicture(
  ownerId: string,
  system: string,
  user: string,
  picture: PresentPicture,
  params: ExtractorParams,
): Promise<{ text: string; model: string | null }> {
  const r = await runVisionWorker({
    ownerId,
    bytes: picture.png,
    mimeType: picture.mime,
    filename: picture.mime === 'image/png' ? 'canvas.png' : 'canvas.jpg',
    systemPrompt: system,
    prompt: `${user}\n\nThe picture is the canvas as it is drawn. Say in the summary what it shows (the drawing, the slides, the figures) as well as its words.`,
    // The extractor's JSON (summary, facts, entities, relations), not a
    // photo's few lines: the vision worker's own cap would cut a big deck's
    // reply off, and a cut reply parses to nothing. runDocumentWorker's
    // generous default.
    maxTokens: params.max_tokens ?? EXTRACT_WITH_PICTURE_MAX_TOKENS,
  });
  if (!r.ran) throw new Error(r.note ?? 'the vision worker did not run');
  return { text: r.text, model: r.model };
}

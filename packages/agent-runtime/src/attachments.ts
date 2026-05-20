/**
 * Attachment text extraction — the one place that turns uploaded bytes into
 * text, used by every surface so behaviour is identical wherever a file enters.
 *
 * Two layers:
 *   - `runVisionWorker` — resolve the owner's default vision worker, transcode
 *     HEIC, run the adapter. Used by the extractor (neutral describe+OCR, for
 *     the durable index) AND by the conversational surfaces (question-aware,
 *     for the live reply).
 *   - `extractAttachmentForTurn` — the conversational helper: dispatch an
 *     attachment to vision (images) or a document parser (pdf/docx/xlsx/text)
 *     and return text for the responder's CURRENT turn. Ephemeral — it never
 *     persists; durable metadata is the extractor's job.
 *
 * This module composes @mantle/db (worker resolution), @mantle/api-keys,
 * @mantle/voice (adapters + the shared prompt), and @mantle/files (parsers +
 * HEIC transcode). None of those depend back on agent-runtime, so there's no
 * cycle.
 */

import { getApiKeyById } from '@mantle/api-keys';
import { bumpWorkerUsage, getDefaultWorker } from '@mantle/db';
import {
  extOf,
  mimeForExt,
  parseDocumentBytes,
  transcodeImageForVision,
  INGESTABLE_EXTS,
} from '@mantle/files';
import { DEFAULT_VISION_DESCRIBE_PROMPT, getVisionAdapter } from '@mantle/voice';

/** Max chars of parsed document text folded into a responder prompt. The full
 *  text is persisted + indexed by the extractor; the turn only needs a slice. */
export const DOC_TEXT_MAX = 24_000;

export type VisionResult = {
  /** true when the adapter ran and returned (text may still be empty). */
  ran: boolean;
  text: string;
  /** Human-readable reason when text is empty / the worker couldn't run. */
  note: string | null;
  model: string | null;
  adapterName?: string;
  tokensIn?: number;
  tokensOut?: number;
};

/**
 * Run the owner's default vision worker over image bytes. HEIC is transcoded
 * to JPEG first. Best-effort: a missing/unwired/undecryptable worker or an
 * adapter error returns `ran:false` + a `note` rather than throwing, so every
 * caller degrades the same way. `prompt` defaults to the worker's configured
 * prompt, then the shared neutral describe+OCR prompt.
 */
export async function runVisionWorker(opts: {
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  filename?: string | null;
  prompt?: string;
  maxTokens?: number;
}): Promise<VisionResult> {
  const worker = await getDefaultWorker(opts.ownerId, 'vision');
  if (!worker?.apiKeyId) {
    return { ran: false, text: '', note: 'No default vision worker configured.', model: null };
  }
  const adapter = getVisionAdapter(worker.provider);
  if (!adapter) {
    return {
      ran: false,
      text: '',
      note: `Vision provider '${worker.provider}' isn't wired.`,
      model: worker.model,
    };
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    return {
      ran: false,
      text: '',
      note: `Vision worker '${worker.slug}' api_key could not be decrypted.`,
      model: worker.model,
    };
  }

  const params = (worker.params ?? {}) as { extraction_prompt?: string; max_tokens?: number };
  const prompt = opts.prompt ?? params.extraction_prompt?.trim() ?? DEFAULT_VISION_DESCRIBE_PROMPT;
  // Vision providers can't read HEIC (iPhone default) — transcode to JPEG.
  const forVision = await transcodeImageForVision(opts.bytes, opts.mimeType, opts.filename);
  try {
    const r = await adapter.extract(forVision.bytes, {
      apiKey,
      mimeType: forVision.mimeType,
      prompt,
      systemPrompt: worker.systemPrompt ?? undefined,
      model: worker.model,
      maxTokens: opts.maxTokens ?? params.max_tokens ?? 2000,
    });
    void bumpWorkerUsage(worker.id);
    const text = r.text?.trim() ? r.text : '';
    return {
      ran: true,
      text,
      note: text ? null : 'Vision worker returned no text.',
      model: worker.model,
      adapterName: adapter.adapterName,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    };
  } catch (err) {
    return {
      ran: false,
      text: '',
      note: `Vision worker failed: ${err instanceof Error ? err.message : String(err)}`,
      model: worker.model,
    };
  }
}

/** Question-aware vision prompt: answer what the user asked, grounded only in
 *  what's visible, plus one line of description so the reply also reads as a
 *  record of the image. */
export function questionAwareVisionPrompt(question: string): string {
  return (
    `The user sent this image and asked: "${question}"\n\n` +
    "Answer their question directly and specifically, grounded only in what's " +
    "actually visible in the image — don't invent details you can't see. Then " +
    'add one short line describing the image overall, so this also serves as a ' +
    'useful record of the photo.'
  );
}

export type AttachmentExtract = {
  kind: 'image' | 'file' | 'unsupported';
  text: string;
  note: string | null;
};

/**
 * Turn an uploaded attachment into text for the responder's CURRENT turn.
 * Images → question-aware vision (neutral when no question); documents
 * (pdf/docx/xlsx/csv/txt/md/json/yaml) → parsed text, capped at DOC_TEXT_MAX.
 * Anything else → `unsupported`. Never persists — the extractor owns the
 * durable index off the same saved node.
 */
export async function extractAttachmentForTurn(opts: {
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  filename: string;
  question?: string;
}): Promise<AttachmentExtract> {
  const ext = extOf(opts.filename);
  const isImage =
    opts.mimeType.startsWith('image/') || mimeForExt(ext).startsWith('image/');

  if (isImage) {
    const question = opts.question?.trim();
    const r = await runVisionWorker({
      ownerId: opts.ownerId,
      bytes: opts.bytes,
      mimeType: opts.mimeType,
      filename: opts.filename,
      prompt: question ? questionAwareVisionPrompt(question) : undefined,
    });
    return { kind: 'image', text: r.text, note: r.note };
  }

  if (INGESTABLE_EXTS.has(ext)) {
    try {
      const raw = (await parseDocumentBytes(opts.bytes, ext)).trim();
      if (!raw) {
        return { kind: 'file', text: '', note: `No text could be extracted from ${opts.filename}.` };
      }
      const text =
        raw.length > DOC_TEXT_MAX
          ? `${raw.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${raw.length - DOC_TEXT_MAX} more characters — call file_read on the node for the full document.]`
          : raw;
      return { kind: 'file', text, note: null };
    } catch (err) {
      return {
        kind: 'file',
        text: '',
        note: `Couldn't parse the ${ext.toUpperCase()} (scanned, encrypted, or corrupt?): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    kind: 'unsupported',
    text: '',
    note: `Unsupported file type '${opts.mimeType || ext || 'unknown'}'.`,
  };
}

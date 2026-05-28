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
  parserRouteForExt,
} from '@mantle/files';
import { DEFAULT_VISION_DESCRIBE_PROMPT, getVisionAdapter } from '@mantle/voice';
import { fallbackCostMicroUsd, recordStepUsage, step } from '@mantle/tracing';

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
    // Attribute the vision call's cost to the active trace step (the
    // extractor's photo_ingest extract_vision, or a conversational turn's
    // attachment step). The adapter returns token counts but no dollar cost,
    // so price via the fallback table. No-op outside a trace. Without this,
    // vision spend read $0 in /debug (file-ingestion.md V1).
    const tokensIn = r.tokensIn ?? 0;
    const tokensOut = r.tokensOut ?? 0;
    recordStepUsage({
      model: worker.model,
      input: tokensIn,
      output: tokensOut,
      costMicroUsd: fallbackCostMicroUsd(worker.model, { input: tokensIn, output: tokensOut }),
    });
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

/**
 * Native document (PDF) extraction — send the whole PDF to the owner's default
 * vision worker's model when its provider supports native documents (Anthropic
 * today; Google next). One call, whole-document context, real layout/tables, no
 * rasterization. Resolves the SAME vision worker (set it to Claude and PDFs go
 * native automatically). Returns `ran:false` when the provider has no native
 * document path, so callers fall back to rasterize → per-page OCR.
 */
export async function runDocumentWorker(opts: {
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  filename?: string | null;
  prompt?: string;
  maxTokens?: number;
}): Promise<VisionResult> {
  // Prefer a dedicated 'document' worker; fall back to the 'vision' worker when
  // none is configured (additive — PDFs still work via vision out of the box).
  const worker =
    (await getDefaultWorker(opts.ownerId, 'document')) ??
    (await getDefaultWorker(opts.ownerId, 'vision'));
  if (!worker?.apiKeyId) {
    return { ran: false, text: '', note: 'No default document or vision worker configured.', model: null };
  }
  const adapter = getVisionAdapter(worker.provider);
  if (!adapter?.extractDocument) {
    return {
      ran: false,
      text: '',
      note: `Vision provider '${worker.provider}' has no native PDF path; using page OCR.`,
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
  try {
    const r = await adapter.extractDocument(opts.bytes, {
      apiKey,
      mimeType: opts.mimeType,
      prompt,
      systemPrompt: worker.systemPrompt ?? undefined,
      model: worker.model,
      // Documents transcribe in one call — honour the worker's max_tokens, but
      // default generous (8000) since the per-image vision default is too small.
      maxTokens: opts.maxTokens ?? params.max_tokens ?? 8000,
    });
    void bumpWorkerUsage(worker.id);
    const text = r.text?.trim() ? r.text : '';
    const tokensIn = r.tokensIn ?? 0;
    const tokensOut = r.tokensOut ?? 0;
    recordStepUsage({
      model: worker.model,
      input: tokensIn,
      output: tokensOut,
      costMicroUsd: fallbackCostMicroUsd(worker.model, { input: tokensIn, output: tokensOut }),
    });
    return {
      ran: true,
      text,
      note: text ? null : 'Document worker returned no text.',
      model: worker.model,
      adapterName: adapter.adapterName,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    };
  } catch (err) {
    return {
      ran: false,
      text: '',
      note: `Document worker failed: ${err instanceof Error ? err.message : String(err)}`,
      model: worker.model,
    };
  }
}

/** Page cap for the live-turn PDF OCR fallback — mirrors the extractor's
 *  MAX_OCR_PAGES, bounding rasterization memory + per-page vision spend. */
const TURN_OCR_PAGES = 10;

/**
 * OCR a scanned / image-only PDF for the CURRENT turn: rasterize its pages to
 * PNG and run each through the default vision worker (neutral transcribe) — the
 * same path the durable extractor takes for a PDF with no text layer. Returns
 * the concatenated text (capped at DOC_TEXT_MAX) or null if it can't render /
 * the worker is unavailable / the scan is blank. Each page is its own trace
 * step for /traces visibility. This is what lets the live reply read a scanned
 * invoice — `parseDocumentBytes` (text extraction) returns nothing for those.
 */
async function ocrPdfForTurn(opts: {
  ownerId: string;
  bytes: Buffer;
  filename: string;
}): Promise<{ text: string; note: string | null } | null> {
  const pages = await (async () => {
    try {
      const { rasterizePdfToPngs } = await import('@mantle/files/rasterize');
      return await step(
        { name: 'rasterize_pdf', kind: 'compute', input: { max_pages: TURN_OCR_PAGES } },
        async (h) => {
          const r = await rasterizePdfToPngs(opts.bytes, { maxPages: TURN_OCR_PAGES });
          h.setMeta({ pages: r.length });
          return r;
        },
      );
    } catch {
      return []; // unrenderable / corrupt / encrypted PDF
    }
  })();
  if (pages.length === 0) return null;

  const parts: string[] = [];
  for (const pg of pages) {
    const res = await step(
      {
        name: 'extract_vision',
        kind: 'llm_call',
        input: { page: pg.pageNumber, mime: 'image/png', bytes: pg.png.length },
      },
      async (h) => {
        const r = await runVisionWorker({
          ownerId: opts.ownerId,
          bytes: pg.png,
          mimeType: 'image/png',
          filename: `${opts.filename}#page-${pg.pageNumber}.png`,
        });
        h.setMeta({
          ran: r.ran,
          note: r.note,
          model: r.model,
          page: pg.pageNumber,
          textLength: r.text.length,
        });
        return r;
      },
    );
    if (res.text.trim()) {
      parts.push(pages.length > 1 ? `[Page ${pg.pageNumber}]\n${res.text.trim()}` : res.text.trim());
    }
  }

  const text = parts.join('\n\n').trim();
  if (!text) return null;
  const capped =
    text.length > DOC_TEXT_MAX
      ? `${text.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${text.length - DOC_TEXT_MAX} more characters — call file_read on the node for the full document.]`
      : text;
  return { text: capped, note: 'Scanned PDF — text recovered via vision OCR.' };
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
      // Trace the parse for the live path too, mirroring the durable extractor
      // (apps/agent/src/extractor.ts readNodeBodyRaw). Makes Tika vs in-process
      // parser tiers visible in /traces on conversational attachments — same
      // diagnostic value as the durable path: parser=tika+chars_out=0 means
      // "Tika is down" vs "doc really has no text" without spelunking logs.
      const route = parserRouteForExt(ext);
      const raw = (
        await step(
          {
            name: 'parse_document',
            kind: 'compute',
            input: { ext, parser: route, bytes_in: opts.bytes.length, filename: opts.filename },
          },
          async (h) => {
            const t = await parseDocumentBytes(opts.bytes, ext);
            h.setMeta({ parser: route, chars_out: t.length, empty: t.trim().length === 0 });
            return t;
          },
        )
      ).trim();
      if (!raw) {
        // No text layer — usually a scan / image-only export (e.g. an invoice).
        if (ext === 'pdf') {
          // 1) Native PDF: hand the whole document to the vision model when its
          //    provider supports it (Claude/Gemini). Best fidelity — whole-doc
          //    context, real tables, no rasterization.
          const native = await step(
            {
              name: 'extract_document',
              kind: 'llm_call',
              input: { mime: 'application/pdf', bytes: opts.bytes.length },
            },
            async (h) => {
              const r = await runDocumentWorker({
                ownerId: opts.ownerId,
                bytes: opts.bytes,
                mimeType: 'application/pdf',
                filename: opts.filename,
              });
              h.setMeta({ ran: r.ran, note: r.note, model: r.model, textLength: r.text.length, tokensOut: r.tokensOut });
              return r;
            },
          );
          if (native.ran && native.text.trim()) {
            const t = native.text.trim();
            const capped =
              t.length > DOC_TEXT_MAX
                ? `${t.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${t.length - DOC_TEXT_MAX} more characters — call file_read on the node for the full document.]`
                : t;
            return { kind: 'file', text: capped, note: 'PDF read natively by the vision model.' };
          }
          // 2) Fall back to rasterize → per-page image OCR (providers without
          //    native PDF, or if the native call failed).
          const ocr = await ocrPdfForTurn({
            ownerId: opts.ownerId,
            bytes: opts.bytes,
            filename: opts.filename,
          });
          if (ocr) return { kind: 'file', text: ocr.text, note: ocr.note };
        }
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

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
 * @mantle/voice (adapters + the shared prompt), and @mantle/files (the parser
 * client: documents, PDF pages and HEIC all read in the parser service). None of those depend back on agent-runtime, so there's no
 * cycle.
 */

import { getApiKeyById, resolveDefaultWorker } from '@mantle/api-keys';
import { bumpWorkerUsage, getDefaultWorker } from '@mantle/db';
import {
  extOf,
  isVisionImage,
  parseDocumentBytes,
  isParserError,
  withParserScope,
  transcodeImageForVision,
  INGESTABLE_EXTS,
  isCadExt,
  parserRouteForExt,
} from '@mantle/files';
import { noteReadCut } from '@mantle/files/read-cut-sink';
import { readerPassOf, readerTextOf } from '@mantle/content/reader-passes';
import { DEFAULT_VISION_DESCRIBE_PROMPT, getVisionAdapter } from '@mantle/voice';
import { step } from '@mantle/tracing';
import { errorMessage, providerErrorStatus, publicProviderErrorMessage } from '@mantle/std';
import { createHash } from 'node:crypto';
import {
  readScannedPdf,
  scanCountsOf,
  scanTextOf,
  scanUnreadSentence,
  type ScanPage,
} from './scan-pdf';

/** The parser codes that are about the document, not the reader's load. */
const PARSER_COUNTED = new Set(['too_large', 'timeout', 'crashed']);

/** Max chars of parsed document text folded into a responder prompt. The full
 *  text is persisted + indexed by the extractor; the turn only needs a slice. */
export const DOC_TEXT_MAX = 24_000;

/** Live-turn ceiling for DWF containers. A DWF's whole parse is CPU
 *  (inflate + scans over every sheet, in the parser service), so a large
 *  container read inline would hold the turn and a parser job slot for
 *  long. Above this size the turn answers with a stored-and-indexing note
 *  instead; the durable extractor reads the same bytes in the background
 *  either way. */
export const DWF_INLINE_PARSE_MAX = 8 * 1024 * 1024;

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
  /** The call's system prompt instead of the worker's own (the extractor's
   *  one pass over a Present canvas, Journal v3 J9). */
  systemPrompt?: string;
  maxTokens?: number;
  /** Ask for the least thinking (a reading task under a tight answer cap). */
  leastThinking?: boolean;
  /** Calls at most: 2 asks one time more when the provider failed with no
   *  status or a 5xx (a timeout, a stall, a dropped line; never a 4xx). A read of many pictures in a row stops at its
   *  first failed call, so one slow answer lost the rest of a sheet (dev
   *  2026-11-17: 23 of 112 pieces of a flow diagram). At most one paid call
   *  more. Default 1. */
  tries?: 1 | 2;
}): Promise<VisionResult> {
  // The one resolution (@mantle/api-keys): the worker, its key reference,
  // a wired adapter (checked before the key is opened), the key.
  const route = await resolveDefaultWorker(
    opts.ownerId,
    'vision',
    (w) => getVisionAdapter(w.provider) !== null,
  );
  if (!route.ok) {
    if (route.why === 'none' || route.why === 'no_key') {
      return { ran: false, text: '', note: 'No default vision worker configured.', model: null };
    }
    return {
      ran: false,
      text: '',
      note:
        route.why === 'unusable'
          ? `Vision provider '${route.worker.provider}' isn't wired.`
          : `Vision worker '${route.worker.slug}' api_key could not be decrypted.`,
      model: route.worker.model,
    };
  }
  const { worker, credential } = route;
  const adapter = getVisionAdapter(worker.provider)!;

  const params = (worker.params ?? {}) as { extraction_prompt?: string; max_tokens?: number };
  const prompt = opts.prompt ?? params.extraction_prompt?.trim() ?? DEFAULT_VISION_DESCRIBE_PROMPT;
  // Vision providers can't read HEIC (iPhone default) — transcode to JPEG.
  const forVision = await transcodeImageForVision(opts.bytes, opts.mimeType, opts.filename);
  const maxTokens = opts.maxTokens ?? params.max_tokens ?? 2000;
  const call = () =>
    adapter.extract(forVision.bytes, {
      ...credential,
      mimeType: forVision.mimeType,
      prompt,
      systemPrompt: opts.systemPrompt ?? worker.systemPrompt ?? undefined,
      model: worker.model,
      maxTokens,
      ...(opts.leastThinking ? { leastThinking: true } : {}),
    });
  try {
    // One time more only where a second call can help: no answer in time,
    // the line dropped, or the provider's own fault (5xx). A refusal (4xx:
    // a bad key, a rate limit, a bad request) is not asked again.
    const again = (err: unknown) => {
      const status = providerErrorStatus(err);
      if (status !== undefined && status < 500) throw err;
      return call();
    };
    const r = await (opts.tries === 2 ? call().catch(again) : call());
    void bumpWorkerUsage(worker.id);
    const text = r.text?.trim() ? r.text : '';
    noteAnswerCut(r.tokensOut, maxTokens);
    // The call's spend (tokens, cost from the price table) was recorded by the
    // adapter registry on the step in context: the extractor's photo_ingest
    // extract_vision, or a conversational turn's attachment step
    // (docs/spend-recording.md, file-ingestion.md V1).
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
      note: `Vision worker failed: ${publicProviderErrorMessage(err, 'vision-worker')}`,
      model: worker.model,
    };
  }
}

/** A model's answer that used its whole token budget stopped there, most
 *  likely in mid-description: said in the read's sink (an extract's;
 *  @mantle/files read-cut-sink.ts), so the file shows as read in part. Only
 *  where the provider counts the answer's tokens; a chat turn has no sink. */
function noteAnswerCut(tokensOut: number | undefined, maxTokens: number): void {
  if (tokensOut === undefined || !Number.isFinite(tokensOut) || tokensOut < maxTokens) return;
  noteReadCut('vision_answer', { what: 'answers', read: 0, total: 1, limit: maxTokens });
}

/** True if the owner's resolved document worker is set to `prefer_native` —
 *  i.e. send PDFs to the model even when they have a text layer. Reads the
 *  dedicated 'document' worker, falling back to 'vision' (which has no such
 *  flag, so it returns false). Cheap metadata read. */
export async function documentWorkerPrefersNative(ownerId: string): Promise<boolean> {
  const worker = await getDefaultWorker(ownerId, 'document');
  return Boolean((worker?.params as { prefer_native?: boolean } | undefined)?.prefer_native);
}

/**
 * Native document (PDF) extraction — send the whole PDF to the owner's
 * document worker's model (falling back to the vision worker) when its provider
 * supports native documents (Anthropic today; Google next). One call,
 * whole-document context, real layout/tables, no rasterization. Returns
 * `ran:false` when the provider has no native document path, so callers fall
 * back to rasterize → per-page OCR.
 */
export async function runDocumentWorker(opts: {
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  filename?: string | null;
  prompt?: string;
  /** The call's system prompt instead of the worker's own (the extractor's
   *  one pass over a Present canvas, Journal v3 J9). */
  systemPrompt?: string;
  maxTokens?: number;
}): Promise<VisionResult> {
  // Prefer a dedicated 'document' worker; fall back to the 'vision' worker when
  // none is configured (additive — PDFs still work via vision out of the box).
  const worker =
    (await getDefaultWorker(opts.ownerId, 'document')) ??
    (await getDefaultWorker(opts.ownerId, 'vision'));
  if (!worker?.apiKeyId) {
    return {
      ran: false,
      text: '',
      note: 'No default document or vision worker configured.',
      model: null,
    };
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
  const credential = await getApiKeyById(worker.apiKeyId);
  if (!credential) {
    return {
      ran: false,
      text: '',
      note: `Vision worker '${worker.slug}' api_key could not be decrypted.`,
      model: worker.model,
    };
  }
  const params = (worker.params ?? {}) as { extraction_prompt?: string; max_tokens?: number };
  const prompt = opts.prompt ?? params.extraction_prompt?.trim() ?? DEFAULT_VISION_DESCRIBE_PROMPT;
  // Documents transcribe in one call — honour the worker's max_tokens, but
  // default generous (8000) since the per-image vision default is too small.
  const maxTokens = opts.maxTokens ?? params.max_tokens ?? 8000;
  try {
    const r = await adapter.extractDocument(opts.bytes, {
      ...credential,
      mimeType: opts.mimeType,
      prompt,
      systemPrompt: opts.systemPrompt ?? worker.systemPrompt ?? undefined,
      model: worker.model,
      maxTokens,
    });
    void bumpWorkerUsage(worker.id);
    const text = r.text?.trim() ? r.text : '';
    noteAnswerCut(r.tokensOut, maxTokens);
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
      note: `Document worker failed: ${publicProviderErrorMessage(err, 'document-worker')}`,
      model: worker.model,
    };
  }
}

/** How long a chat turn reads a scanned PDF for (readScannedPdf
 *  `deadline`): a page not started by then is not read for this answer,
 *  and the turn says so. About 50 pages at 4 at once (the scan bench: 3.7
 *  to 5.0 s a page). The saved file is read whole in the background by the
 *  extractor, as every upload is. */
export const TURN_SCAN_MS = 60_000;

/**
 * Read a scanned / image-only PDF for the CURRENT turn with the Scan reader,
 * page by page (readScannedPdf, ./scan-pdf.ts; docs/ai-workers.md, "Scanned
 * PDFs outside a book"): the same read the durable extractor makes of a PDF
 * with no text layer, every page, with no page cap. Per page, not the whole
 * file in one call: the price is the engine's per page either way, and each
 * page gets the check (a page read badly is left out, never shown as the
 * page), a figure its vision description. A long PDF is read for
 * TURN_SCAN_MS: the pages not reached, and every page not read, are said in
 * the note, never cut in silence. The text is capped at DOC_TEXT_MAX for the
 * prompt, said too. Null when no page could be read; the note then says why.
 */
async function scanPdfForTurn(opts: {
  ownerId: string;
  bytes: Buffer;
  filename: string;
  /** The file is saved (the extractor reads it whole in the background). */
  saved: boolean;
}): Promise<{ text: string; note: string }> {
  const sha256 = createHash('sha256').update(opts.bytes).digest('hex');
  const kept: ScanPage[] = [];
  let total = 0;
  let stopped: string | null = null;
  try {
    const r = await readScannedPdf({
      ownerId: opts.ownerId,
      bytes: opts.bytes,
      sha256,
      filename: opts.filename,
      deadline: Date.now() + TURN_SCAN_MS,
      onWindow: async (pages, pagesTotal) => {
        kept.push(...pages);
        total = pagesTotal;
      },
    });
    kept.splice(0, kept.length, ...r.pages);
    total = r.pagesTotal;
  } catch (err) {
    // The parser busy or the file unopenable: what was read stands, the
    // rest is said.
    // The parser's own words only: any other error is not shown.
    stopped =
      isParserError(err) && err.retryable && !PARSER_COUNTED.has(err.code)
        ? 'the document reader is busy or restarting'
        : isParserError(err)
          ? `the PDF could not be read on (${errorMessage(err)})`
          : 'the read stopped on an error';
  }
  const text = scanTextOf(kept, total);
  const { read, unread } = scanCountsOf(kept);
  const left = Math.max(0, total - kept.length);
  const later = opts.saved
    ? ' The saved file is read whole in the background; its full text is searchable when that ends (file_read).'
    : '';
  const parts: string[] = [];
  if (total > 0) parts.push(`Scanned PDF of ${total} pages: ${read} read by the Scan reader`);
  const why = scanUnreadSentence(unread);
  if (why) parts.push(why);
  if (stopped) parts.push(`${left > 0 ? `${left} pages not read: ` : ''}${stopped}`);
  const note =
    parts.length > 0
      ? `${parts.join('; ')}.${why || stopped ? later : ''}`
      : `${opts.filename} could not be read just now: ${stopped ?? 'no page was read'}.${later}`;
  const capped =
    text.length > DOC_TEXT_MAX
      ? `${text.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${text.length - DOC_TEXT_MAX} more characters: call file_read on the node for the full document.]`
      : text;
  return { text: capped, note };
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
  /** The saved file, when there is one: its home workspace holds the off
   *  list of its Reader (a format the core has no text reader for). */
  fileId?: string | null;
}): Promise<AttachmentExtract> {
  // A person is waiting: a busy parser is said at once, not waited out (the
  // background extract keeps its retries), and the turn's one file does not
  // queue behind this process's background exchanges.
  return withParserScope({ interactive: true, uncapped: true }, () => extractForTurn(opts));
}

async function extractForTurn(opts: {
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  filename: string;
  question?: string;
  fileId?: string | null;
}): Promise<AttachmentExtract> {
  const ext = extOf(opts.filename);
  // EXT routing beats the client-supplied mime: uploaders send `image/vnd.dwg`
  // for DWGs, and the old mime-first gate shipped the CAD binary to the vision
  // worker instead of taking the dwg deferral below.
  const isImage = isVisionImage(ext, opts.mimeType);

  if (isImage) {
    const question = opts.question?.trim();
    try {
      const r = await runVisionWorker({
        ownerId: opts.ownerId,
        bytes: opts.bytes,
        mimeType: opts.mimeType,
        filename: opts.filename,
        prompt: question ? questionAwareVisionPrompt(question) : undefined,
      });
      return { kind: 'image', text: r.text, note: r.note };
    } catch (err) {
      // A HEIC photo the parser could not convert just now (busy,
      // restarting): never sent on unconverted.
      if (!isParserError(err)) throw err;
      return {
        kind: 'image',
        text: '',
        note: `${opts.filename} could not be read just now (the image reader is busy or restarting): try again in a moment.`,
      };
    }
  }

  // A format the core has no text reader for: the text of the box's own
  // Reader, as the durable extract takes it (load-body.ts; docs/pipelines.md,
  // "Text and pictures from every Reader").
  const own =
    parserRouteForExt(ext) === 'none'
      ? await readerPassOf(opts.ownerId, opts.fileId ?? null, ext, 'text')
      : null;
  if (INGESTABLE_EXTS.has(ext) || own) {
    const isPdf = ext === 'pdf';

    // See DWF_INLINE_PARSE_MAX: a big drawing set is deferred to the durable
    // extractor rather than ground through synchronously on the request path.
    if (ext === 'dwf' && opts.bytes.length > DWF_INLINE_PARSE_MAX) {
      return {
        kind: 'file',
        text: '',
        note: `${opts.filename} is a large drawing set — it is stored and being indexed in the background; its sheets and layers become searchable shortly.`,
      };
    }

    // CAD parsing (DWG, DXF, DGN) is a CAD-tier round trip in the parser
    // (convert/read + parse + render): never inline work for a live turn,
    // whatever the size. The durable extractor pays it once in the background.
    if (isCadExt(ext)) {
      return {
        kind: 'file',
        text: '',
        note: `${opts.filename} is a CAD drawing — it is stored and being indexed in the background; its layers and annotation text become searchable shortly.`,
      };
    }

    // Native-PDF attempt (Claude/Gemini): the whole document in one call —
    // real layout/tables, no rasterization. Returns null when the provider
    // has no native path or the call produced nothing, so callers fall through.
    const tryNativePdf = async (): Promise<AttachmentExtract | null> => {
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
          h.setMeta({
            ran: r.ran,
            note: r.note,
            model: r.model,
            textLength: r.text.length,
            tokensOut: r.tokensOut,
          });
          return r;
        },
      );
      if (!native.ran || !native.text.trim()) return null;
      const t = native.text.trim();
      const capped =
        t.length > DOC_TEXT_MAX
          ? `${t.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${t.length - DOC_TEXT_MAX} more characters — call file_read on the node for the full document.]`
          : t;
      return { kind: 'file', text: capped, note: 'PDF read natively by the model.' };
    };

    try {
      // Trace the parse for the live path too, mirroring the durable extractor
      // (server/api/src/extractor.ts readNodeBodyRaw): which reader ran and
      // what came out, and a parser failure's typed code, visible in /traces
      // on conversational attachments.
      const route = own ? 'pipeline' : parserRouteForExt(ext);
      const raw = (
        await step(
          {
            name: 'parse_document',
            kind: 'compute',
            input: { ext, parser: route, bytes_in: opts.bytes.length, filename: opts.filename },
          },
          async (h) => {
            const t = await parseDocumentBytes(
              opts.bytes,
              ext,
              own ? (bytes) => readerTextOf(own, bytes) : undefined,
            );
            h.setMeta({ parser: route, chars_out: t.length, empty: t.trim().length === 0 });
            return t;
          },
        )
      ).trim();
      if (!raw) {
        // No text layer: a scan / image-only export (e.g. an invoice). The
        // Scan reader reads it page by page (no vision, no native read).
        if (isPdf) {
          const scan = await scanPdfForTurn({
            ownerId: opts.ownerId,
            bytes: opts.bytes,
            filename: opts.filename,
            saved: !!opts.fileId,
          });
          return { kind: 'file', text: scan.text, note: scan.note };
        }
        return {
          kind: 'file',
          text: '',
          note: `No text could be extracted from ${opts.filename}.`,
        };
      }
      // prefer_native: a PDF with a text layer the document worker is set to
      // read through the model (tabular PDFs whose text layer scrambles
      // columns): its read, else the text layer.
      if (isPdf && (await documentWorkerPrefersNative(opts.ownerId))) {
        const n = await tryNativePdf();
        if (n) return n;
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
        note:
          isParserError(err) && err.retryable && !PARSER_COUNTED.has(err.code)
            ? `${opts.filename} could not be read just now (the document reader is busy or restarting): try again in a moment. It is stored and will be indexed in the background.`
            : `Couldn't parse the ${ext.toUpperCase()} (scanned, encrypted, too large, or corrupt?): ${errorMessage(err)}`,
      };
    }
  }

  return {
    kind: 'unsupported',
    text: '',
    note: `Unsupported file type '${opts.mimeType || ext || 'unknown'}'.`,
  };
}

/**
 * Extractor: Embedded-image extraction, vision ingest for image nodes, OCR ingest for scanned PDFs.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { extOf, ensureExtractedImagesFolder, upsertFile } from '@mantle/files';
import { startTrace, step } from '@mantle/tracing';
import { runDocumentWorker, runVisionWorker } from '@mantle/agent-runtime';
import { errorMessage } from '@mantle/std';
import { cleanText } from './text';
import { loadFileBytes } from './file-bytes';
import { stepInOwnTrace } from './trace';

/** Formats that can carry a picture worth pulling out. Deliberately narrower
 *  than INGESTABLE_EXTS — there is no point opening a .txt looking for a
 *  diagram, and every ext listed here has an extractor behind it. */
const IMAGE_BEARING_EXTS = new Set([
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'xlsm',
  'odt',
  'ods',
  'odp',
  'doc',
  'ppt',
  'xls',
  'xlsb',
  'rtf',
  // DWF plot sets: one thumbnail per published sheet (marked essential in
  // the extractor, so the small-image floor doesn't drop them).
  'dwf',
  // DWG drawings: one essential model-space render from the sidecar.
  'dwg',
  // DXF drawings: same single render off the same sidecar exchange.
  'dxf',
]);

/** Tag marking a file node as derived from a document rather than uploaded.
 *  The lookup path for "show me the pictures from that manual". */
const EXTRACTED_IMAGE_TAG = 'extracted-image';

/**
 * Pull the diagrams and screenshots out of a document and save them as real
 * image files under `files/extracted-images/<document>/`.
 *
 * This exists because some answers cannot be described, only shown: a manual's
 * screenshot of a settings screen is the answer to "how do I configure this",
 * and every text parser in the stack throws it away. Saving them as ordinary
 * `file` nodes means the rest of the system needs no special case — the
 * extractor indexes them like any image (vision describe + OCR, which reads
 * the UI labels *in* the screenshot), Pages embeds them by node id, and the
 * assistant can show them in chat.
 *
 * Shaped exactly like {@link maybeAutoTableSpreadsheet}: best-effort,
 * isolated, deduped by `data.sourceFileId` so re-ingest never doubles, and
 * incapable of blocking the text pass.
 *
 * **Cost.** Extraction itself is free — no model runs here. But each image
 * saved becomes a node the extractor will later run the vision worker over,
 * so this function's real spend is `images kept × one vision call`. That is
 * why the gate in `@mantle/files/embedded-images` is deliberately strict and
 * why the per-document cap exists. A deck of sixty slides must not turn into
 * sixty LLM calls.
 */
export async function maybeExtractEmbeddedImages(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  maxImages?: number | null,
): Promise<void> {
  if (node.type !== 'file') return;
  const data = (node.data ?? {}) as Record<string, unknown>;
  // Never recurse: an extracted image is itself a file node, and must not be
  // reopened looking for images inside it.
  if (typeof data.sourceFileId === 'string') return;
  const nameForExt = typeof data.filename === 'string' ? data.filename : node.title;
  const ext = extOf(nameForExt);
  if (!IMAGE_BEARING_EXTS.has(ext)) return;

  // Dedupe: if this document already produced images, do nothing.
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sourceFileId' = ${node.id}`,
      ),
    )
    .limit(1);
  if (existing) return;

  const loaded = await loadFileBytes(node);
  if (!loaded) {
    // A byte-load failure used to return silently, which made it
    // INDISTINGUISHABLE from "this document has no pictures" — both left no
    // trace step at all. That ambiguity is the point of the fix: you could not
    // tell a document that was read and held nothing from one the pass never
    // opened, so a corpus whose bytes are unreachable (a half-finished sync, a
    // missing object) looked exactly like a corpus with no diagrams in it.
    await stepInOwnTrace(
      ownerId,
      node,
      {
        name: 'extract_images',
        kind: 'compute',
        input: { filename: nameForExt, sourceFileId: node.id },
      },
      async (h) => {
        h.setMeta({ candidates: 0, kept: 0, bytes_available: false });
        h.setError('could not load file bytes — image extraction never ran for this document');
      },
    );
    return;
  }

  const { extractEmbeddedImages, buildImageTitles, buildImageFilename, buildSourceSlug } =
    await import('@mantle/files/embedded-images');
  const result = await extractEmbeddedImages(loaded.bytes, loaded.ext, {
    // Blank/0 on the worker means "use the built-in default", not "keep none".
    maxImages: maxImages && maxImages > 0 ? maxImages : undefined,
  });
  if (result.images.length === 0) {
    // Still worth a step when there WERE candidates: "this manual produced no
    // images" should be explainable from /traces rather than mysterious.
    if (result.candidates > 0) {
      await stepInOwnTrace(
        ownerId,
        node,
        { name: 'extract_images', kind: 'compute', input: { filename: loaded.filename } },
        async (h) => {
          h.setMeta({ candidates: result.candidates, kept: 0, rejected: result.rejected });
        },
      );
    } else if (ext === 'dwg' || ext === 'dxf' || ext === 'dwf') {
      // CAD formats are different from a manual with no pictures: a drawing
      // ALWAYS has renderable content, so zero candidates means the render
      // tier failed (sidecar down/missing, render error) — invisible before
      // this step existed. Record the reason so /traces explains the missing
      // image child instead of leaving no trace at all.
      const reason =
        ext === 'dwg'
          ? await (await import('@mantle/files/dwg')).explainDwgImageMiss(loaded.bytes)
          : ext === 'dxf'
            ? await (await import('@mantle/files/dxf')).explainDxfImageMiss(loaded.bytes)
            : 'no sheets rendered and no embedded thumbnails found';
      await stepInOwnTrace(
        ownerId,
        node,
        { name: 'extract_images', kind: 'compute', input: { filename: loaded.filename } },
        async (h) => {
          h.setMeta({ candidates: 0, kept: 0 });
          h.setError(`no render produced for this drawing — ${reason}`);
        },
      );
    }
    return;
  }

  // Extension included (90-10-01-dwg vs 90-10-01-dxf) so cross-format twins
  // of one drawing never share a folder or an image path — see buildSourceSlug.
  const sourceSlug = buildSourceSlug(loaded.filename);
  const titles = buildImageTitles(result.images, node.title || loaded.filename);

  await stepInOwnTrace(
    ownerId,
    node,
    {
      name: 'extract_images',
      kind: 'compute',
      input: {
        filename: loaded.filename,
        candidates: result.candidates,
        keeping: result.images.length,
        sourceFileId: node.id,
        // Tier visibility (DWF): a box whose sidecar was down/busy shows
        // thumbnails here instead of renders — the downgrade is explainable
        // from /traces rather than only from PNG dimensions.
        ...(result.images.some((i) => i.provenance)
          ? {
              renders: result.images.filter((i) => i.provenance === 'sidecar_render').length,
              thumbnails: result.images.filter((i) => i.provenance === 'embedded_thumbnail').length,
            }
          : {}),
      },
    },
    async (h) => {
      const folderPath = await ensureExtractedImagesFolder({
        ownerId,
        sourceSlug,
        sourceTitle: node.title || loaded.filename,
      });
      const createdIds: string[] = [];
      const saveErrors: string[] = [];
      for (const [i, img] of result.images.entries()) {
        const title = titles[i]!;
        try {
          const saved = await upsertFile({
            ownerId,
            parentPath: folderPath,
            filename: buildImageFilename(img, sourceSlug),
            bytes: img.bytes,
            title,
            tags: [EXTRACTED_IMAGE_TAG, `from:${sourceSlug}`],
            data: {
              sourceFileId: node.id,
              sourceOrdinal: img.ordinal,
              sourceTotal: result.images.length,
              ...(img.location ? { sourceLocation: img.location } : {}),
              // Which tier produced the pixels (DWF: sidecar render vs the
              // container's small preview) — the predicate the backfill's
              // --upgrade-dwf mode selects on.
              ...(img.provenance ? { provenance: img.provenance } : {}),
              extractedFrom: node.title || loaded.filename,
              // Read back by the vision path so the durable index carries the
              // document this picture came from — a bare "a screenshot of a
              // settings screen" retrieves for nobody. See composeImageBody.
              imageContext: buildImageContext({
                title,
                ordinal: img.ordinal,
                total: result.images.length,
                sourceTitle: node.title || loaded.filename,
                location: img.location,
                heading: img.heading,
                caption: img.caption,
                altText: img.altText,
              }),
            },
          });
          createdIds.push(saved.id);
        } catch (err) {
          // One bad image must not cost the rest of the document — but the
          // failure must reach the trace. A console.error alone made a
          // fully-failed save loop end status=success with created:0, which
          // read exactly like "this document has no pictures" (the same
          // ambiguity the bytes_available fix above exists to kill).
          saveErrors.push(errorMessage(err));
          console.error('[extractor] embedded image save failed:', saveErrors.at(-1));
        }
      }
      h.setMeta({
        created: createdIds.length,
        candidates: result.candidates,
        rejected: result.rejected,
        folder: folderPath,
        ...(saveErrors.length > 0
          ? { save_errors: saveErrors.length, first_save_error: saveErrors[0] }
          : {}),
      });
      if (createdIds.length === 0 && saveErrors.length > 0) {
        h.setError(`every image save failed — first error: ${saveErrors[0]}`);
      }
      return createdIds;
    },
  );
}

/**
 * The provenance header stored on an extracted image and prepended to its
 * vision description before indexing.
 *
 * Retrieval is the whole reason this exists. A vision worker looking at a
 * cropped screenshot writes something like "a mobile settings screen with
 * several input fields" — true, and useless for finding it, because nothing
 * in that sentence mentions the manual, the step, or the subject. Folding the
 * document's own words back in is what makes "how do I set the APN?" reach
 * the picture that answers it.
 */
function buildImageContext(args: {
  title: string;
  ordinal: number;
  total: number;
  sourceTitle: string;
  location?: { page?: number; slide?: number; sheet?: string };
  heading?: string;
  caption?: string;
  altText?: string;
}): string {
  const where =
    args.location?.page != null
      ? `, page ${args.location.page}`
      : args.location?.slide != null
        ? `, slide ${args.location.slide}`
        : args.location?.sheet
          ? `, sheet "${args.location.sheet}"`
          : '';
  const lines = [
    `Image ${args.ordinal} of ${args.total} from "${args.sourceTitle}"${where}.`,
    args.heading ? `Section: ${args.heading}` : '',
    args.caption ? `Caption: ${args.caption}` : '',
    args.altText ? `Alt text: ${args.altText}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Compose what gets indexed for an image: its document provenance first, then
 * whatever the vision worker read out of the pixels. Plain concatenation —
 * both halves are wanted verbatim in the summary, the embedding and the
 * chunks.
 */
export function composeImageBody(data: Record<string, unknown>, visionText: string): string {
  const context = typeof data.imageContext === 'string' ? data.imageContext.trim() : '';
  return context ? `${context}\n\n${visionText}` : visionText;
}

/**
 * Vision-ingest an image file node: run the default vision worker (neutral
 * describe+OCR) over the bytes, persist the result as `data.text` (+
 * `vision_model`), and RETURN the text so the caller indexes it in the same
 * extractNode pass (summary + embedding + facts). Single pass — no
 * node_ingested re-fire, no second extractor round-trip.
 *
 * This is the SINGLE durable-metadata path for images, however they entered —
 * Files upload, disk-sync watcher, MCP file_upload, AND the chat/Telegram
 * surfaces (whose own inline vision is question-aware and used only for the
 * live reply; they no longer persist `data.text`, so every image lands here).
 *
 * The early `data.text` persist is deliberate robustness: the picture stays
 * searchable even if the caller's downstream summary/embedding step later
 * fails. Best-effort otherwise: a missing/unwired/erroring vision worker
 * returns null (image stays findable by filename) — the `photo_ingest` trace's
 * extract_vision step records the reason.
 */
export async function visionIngestImageNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<{ text: string | null; failure: string | null }> {
  // Bytes from disk (uploads) or object storage (email image attachments).
  const loaded = await loadFileBytes(node);
  if (!loaded) return { text: null, failure: 'file bytes could not be read from disk or storage' };
  const filename = loaded.filename;

  return await startTrace(
    {
      kind: 'photo_ingest',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { source: 'extractor', filename },
    },
    async () => {
      const bytes = await step(
        { name: 'read_file', kind: 'compute', input: { filename } },
        async (h) => {
          h.setMeta({ bytes: loaded.bytes.length });
          return loaded.bytes;
        },
      );
      const mimeType = loaded.mime;
      const result = await step(
        {
          name: 'extract_vision',
          kind: 'llm_call',
          input: { mime: mimeType, bytes: bytes.length },
        },
        async (h) => {
          // Neutral describe+OCR (no question) — the durable, query-independent
          // metadata pass. Shares the single vision implementation with the
          // conversational surfaces (HEIC transcode + worker resolution live
          // inside runVisionWorker). A missing/unwired/erroring worker returns
          // ran:false + a note rather than throwing; the trace records it.
          const r = await runVisionWorker({ ownerId, bytes, mimeType, filename });
          h.setMeta({
            ran: r.ran,
            note: r.note,
            model: r.model,
            adapter: r.adapterName,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            textLength: r.text.length,
          });
          return r;
        },
      );

      if (!result.text) {
        // Nothing to index — hand the WHY up so the terminal skip names it
        // (a wrong model id fails here silently otherwise; 2026-08-31).
        return { text: null, failure: result.note ?? 'vision worker returned no text' };
      }
      const text = cleanText(result.text); // strip NULs the model/OCR may emit

      // Persist data.text now (robustness — survives a later index failure),
      // then hand the text back to extractNode to index in this same pass.
      await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${result.model ?? ''}::text)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
        h.setMeta({ chars: text.length });
      });
      return { text, failure: null };
    },
  );
}

/** Page cap for PDF OCR — bounds rasterization memory + per-page vision spend. */
const MAX_OCR_PAGES = 10;

/**
 * OCR-ingest a scanned / image-only PDF file node. When a PDF has no text layer
 * (`parseDocumentBytes` yields nothing and `readNodeBodyRaw` falls back to the
 * filename), rasterize its pages to PNG and run each through the default vision
 * worker — exactly the neutral describe+OCR path images already take. The
 * concatenated text is persisted as `data.text` (+ `vision_model`, `ocr`) and
 * RETURNED so extractNode indexes it in the same pass (summary + embedding +
 * facts). Best-effort: a missing/erroring vision worker, an unrenderable PDF,
 * or a blank scan returns null and the trace records why. Page-capped at
 * MAX_OCR_PAGES. Mirrors {@link visionIngestImageNode}.
 */
export async function ocrIngestPdfNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<{ text: string | null; encrypted: boolean; bytesMissing: boolean }> {
  // Bytes from disk (uploads) or object storage (email PDF attachments).
  const loaded = await loadFileBytes(node);
  // bytesMissing = we couldn't retrieve the file at all (no disk path, and the
  // object isn't in storage — e.g. an email attachment indexed by metadata
  // whose body was never persisted). Distinct from "we have it but it's an
  // unreadable scan": the caller records `bytes_unavailable`, not the
  // misleading `no_text_layer`, so the operator knows to RE-FETCH not re-OCR.
  if (!loaded) return { text: null, encrypted: false, bytesMissing: true };
  const filename = loaded.filename;

  return await startTrace(
    {
      kind: 'photo_ingest',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { source: 'extractor', mode: 'pdf_ocr', filename },
    },
    async () => {
      const buf = await step(
        { name: 'read_file', kind: 'compute', input: { filename } },
        async (h) => {
          h.setMeta({ bytes: loaded.bytes.length });
          return loaded.bytes;
        },
      );

      // 1) Native PDF first — one call to the vision model (Claude/Gemini),
      //    whole-document context + real tables, no rasterization. Only runs
      //    when the worker's provider supports it; else falls through to the
      //    per-page raster OCR below.
      const native = await step(
        {
          name: 'extract_document',
          kind: 'llm_call',
          input: { mime: 'application/pdf', bytes: buf.length },
        },
        async (h) => {
          const r = await runDocumentWorker({
            ownerId,
            bytes: buf,
            mimeType: 'application/pdf',
            filename,
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
      // A password-protected PDF surfaces here as a provider 400 whose message
      // says "password protected" (and the raster fallback fails the same way).
      // Track it so the caller can record an honest `encrypted_pdf` skip rather
      // than the misleading `no_text_layer`.
      let encrypted = !native.ran && /password/i.test(native.note ?? '');
      if (native.ran && native.text.trim()) {
        const text = cleanText(native.text.trim());
        await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
          await db
            .update(nodes)
            // native PDF read, not page OCR — flag it accordingly (`native_pdf`)
            // so the marker is honest; downstream nothing reads `ocr` today.
            .set({
              data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${native.model ?? ''}::text, 'native_pdf', true)`,
              updatedAt: new Date(),
            })
            .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
          h.setMeta({ chars: text.length, native: true });
        });
        return { text, encrypted: false, bytesMissing: false };
      }

      // 2) Fall back to rasterize → per-page image OCR.
      const pages = await step(
        { name: 'rasterize_pdf', kind: 'compute', input: { max_pages: MAX_OCR_PAGES } },
        async (h) => {
          try {
            const { rasterizePdfToPngs } = await import('@mantle/files/rasterize');
            const r = await rasterizePdfToPngs(buf, { maxPages: MAX_OCR_PAGES });
            h.setMeta({ pages: r.length });
            return r;
          } catch (err) {
            // Unrenderable / corrupt / encrypted PDF — record and give up.
            const msg = errorMessage(err);
            if (/password/i.test(msg)) encrypted = true;
            h.setMeta({ pages: 0, error: msg });
            return [];
          }
        },
      );
      if (pages.length === 0) return { text: null, encrypted, bytesMissing: false };

      const parts: string[] = [];
      let model: string | null = null;
      for (const pg of pages) {
        const res = await step(
          {
            name: 'extract_vision',
            kind: 'llm_call',
            input: { page: pg.pageNumber, mime: 'image/png', bytes: pg.png.length },
          },
          async (h) => {
            const r = await runVisionWorker({
              ownerId,
              bytes: pg.png,
              mimeType: 'image/png',
              filename: `${filename}#page-${pg.pageNumber}.png`,
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
        if (res.model) model = res.model;
        if (res.text.trim()) {
          parts.push(
            pages.length > 1 ? `[Page ${pg.pageNumber}]\n${res.text.trim()}` : res.text.trim(),
          );
        }
      }

      const text = cleanText(parts.join('\n\n').trim());
      if (!text) return { text: null, encrypted, bytesMissing: false }; // worker unavailable / blank scan / encrypted

      await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${model ?? ''}::text, 'ocr', true)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
        h.setMeta({ chars: text.length, pages: pages.length });
      });
      return { text, encrypted: false, bytesMissing: false };
    },
  );
}

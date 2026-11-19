/**
 * Extractor: Embedded-image extraction, vision ingest for image nodes, OCR ingest for scanned PDFs.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createPartOfFile, db, markContentChanged, nodes } from '@mantle/db';
import {
  CAD_EXTS,
  MAX_EMBEDDED_IMAGES_CEILING,
  MAX_EMBEDDED_IMAGES_PER_DOC,
  PDF_MAX_BYTES,
  deleteFileById,
  extOf,
  picturesLeftOut,
  ensureExtractedImagesFolder,
  isCadExt,
  isDrawingExt,
  isParserError,
  parserPdfPageCount,
  parserRasterizePdf,
  upsertFile,
} from '@mantle/files';
import { log, startTrace, step } from '@mantle/tracing';
import { runDocumentWorker, runVisionWorker } from '@mantle/runtime/agent';
import { errorMessage } from '@mantle/std';
import { cleanText } from './text';
import {
  readerPassOf,
  readerStandsOverFile,
  standingReaderPictures,
} from '@mantle/content/reader-passes';
import { agentPageTextOf } from '@mantle/content/page-passages';
import type { SpooledPictures } from '@mantle/content/picture-spool';
import type { EmbeddedImage } from '@mantle/files/embedded-images';
import {
  picturesByWindows,
  picturesLeftOutOf,
  picturesNeedWindows,
  type PdfPicturesRead,
} from '@mantle/content/pdf-picture-windows';
import { loadFileBytes } from './file-bytes';
import { stepInOwnTrace } from './trace';

/** Picture formats that came with the parser service (anydoc's e-book assets,
 *  Visio's media parts). Approved by the owner on 2026-10-27 for NEW uploads
 *  only: every picture kept is a vision call when it is indexed, so a file
 *  already in a brain (read before, or skipped) is never opened for them,
 *  and the images backfill script does not list them. */
const NEW_UPLOAD_ONLY_IMAGE_EXTS = new Set(['epub', 'vsdx']);

/** No pass has read this file's current bytes: a new upload, or new bytes
 *  (a content change drops these keys, BYTE_DERIVED_DATA_KEYS). */
function bytesUnread(data: Record<string, unknown>): boolean {
  return (
    data.indexing_applied == null &&
    data.extract_completed_at == null &&
    data.extract_skipped == null
  );
}

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
  // DWG, DXF and DGN drawings: one essential model-space render from the
  // parser's CAD tier.
  ...CAD_EXTS,
  ...NEW_UPLOAD_ONLY_IMAGE_EXTS,
]);

/** Tag marking a file node as derived from a document rather than uploaded.
 *  The lookup path for "show me the pictures from that manual". */
const EXTRACTED_IMAGE_TAG = 'extracted-image';

/**
 * Pull the diagrams and screenshots out of a document and save them as real
 * image files under `files/auto-filed/extracted-images/file-<file id>/`.
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
  // A format the core reads no pictures of: its own Reader's pictures, when
  // the box has one that gives them (`produces.pictures`) and it is on where
  // the file lives (docs/pipelines.md, "Text and pictures from every
  // Reader"). Its run is the database pass's, kept for the extract. As for
  // the parser's newer picture formats, for new bytes only: every picture
  // kept is a vision call when it is indexed.
  const own =
    !IMAGE_BEARING_EXTS.has(ext) && bytesUnread(data)
      ? await readerPassOf(ownerId, node.id, ext, 'pictures')
      : null;
  if (!IMAGE_BEARING_EXTS.has(ext) && !own) return;
  if (NEW_UPLOAD_ONLY_IMAGE_EXTS.has(ext) && !bytesUnread(data)) return;

  // Dedupe: if this document already produced images from its current
  // bytes, do nothing. New bytes (a replace or a restore, data.replaced_at;
  // file history) never remove the images of the older ones: Pages embed
  // them by id, and data is never thrown away. They are marked
  // `olderVersion` (an image made from these bytes again, a restore, loses
  // the mark), and a new pass runs only when a person put the new bytes
  // there by hand (data.replaced_by 'person'): any other save (an agent's,
  // an app's, an MCP client's, an export's, the system's) keeps the older
  // images and starts no vision work.
  const sha = typeof data.sha256 === 'string' ? data.sha256 : null;
  const replacedAt = typeof data.replaced_at === 'string' ? data.replaced_at : null;
  // An image's bytes are its file's current ones: made from this sha256, or
  // (an image from before the mark) made after the last replace.
  const current = sql`coalesce(${nodes.data}->>'sourceSha256' = ${sha ?? ''}
    or (${nodes.data}->>'sourceSha256' is null
        and (${replacedAt}::timestamptz is null or ${nodes.createdAt} >= ${replacedAt}::timestamptz)),
    false)`;
  const marked = await db
    .update(nodes)
    .set({
      data: sql`case when ${current} then ${nodes.data} - 'olderVersion'
                     else ${nodes.data} || '{"olderVersion": true}'::jsonb end`,
    })
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sourceFileId' = ${node.id}`,
        sql`((${nodes.data}->'olderVersion') is not null) = ${current}`,
      ),
    )
    .returning({ id: nodes.id });
  const prior = (await db.execute(sql`
    select count(*) filter (where ${current})::int as cur, count(*)::int as total
      from ${nodes}
     where ${nodes.ownerId} = ${ownerId} and ${nodes.type} = 'file'
       and ${nodes.data}->>'sourceFileId' = ${node.id}`)) as unknown as {
    cur: number;
    total: number;
  }[];
  // A file that left pictures out (`data.images`, G4) is a candidate again
  // (G5): the pictures of its current bytes are kept by their sha256, and
  // only the new ones are saved (one vision call each).
  const currentCount = Number(prior[0]?.cur ?? 0);
  if (currentCount > 0 && !picturesLeftOut(data)) return;
  const have =
    currentCount > 0 ? await extractedPicturesOf(ownerId, node.id, current) : new Set<string>();
  // Set only by the two person routes (an upload with replace, a restore):
  // a login's scope alone is no sign (apps and MCP clients run in one).
  const personStarted = data.replaced_by === 'person';
  if (replacedAt && !personStarted) {
    if (marked.length > 0) {
      log('extractor').info(
        `${marked.length} images marked as from an older version; no new image pass (the new bytes were not a person's upload or restore)`,
      );
    }
    return;
  }
  // A folder of their own when older images are there (their names would
  // clash): one per set of bytes.
  const olderImages = Number(prior[0]?.total ?? 0) > 0;
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

  const {
    extractEmbeddedImages,
    buildImageTitles,
    buildImageFilename,
    buildSourceSlug,
    describeImageBytes,
  } = await import('@mantle/files/embedded-images');
  // A PDF past the size pdfjs opens is read in page windows (G2); so are the
  // pages of a long PDF past the ones one read scans, and a PDF whose one
  // read left pictures out.
  const isPdf = loaded.ext === 'pdf' && !own;
  // Every picture of a PDF is kept (Jason, 2026-11-19: "Yes, no cap"): a
  // parser job keeps MAX_EMBEDDED_IMAGES_CEILING at most, a pace, and what
  // one job leaves out is read by smaller windows. Other formats keep the
  // worker's cap (blank/0: the built-in default, not "keep none").
  const cap = isPdf
    ? MAX_EMBEDDED_IMAGES_CEILING
    : maxImages && maxImages > 0
      ? maxImages
      : MAX_EMBEDDED_IMAGES_PER_DOC;
  // A book whose Reader stands over the core's PDF read (P2) is read by
  // windows like any PDF, but each window keeps the scan rule: its scanned
  // pages are the Reader's to picture (G1), never page scans here.
  const book = isPdf && (await readerStandsOverFile(ownerId, node.id, data.sha256));
  const whole =
    isPdf && loaded.bytes.length > PDF_MAX_BYTES
      ? null
      : await extractEmbeddedImages(loaded.bytes, loaded.ext, {
          maxImages: cap,
          ...(own ? { reader: own } : {}),
        });
  const result: PdfPicturesRead =
    isPdf && picturesNeedWindows(loaded.bytes.length, PDF_MAX_BYTES, whole)
      ? await picturesByWindows(loaded.bytes, cap, whole, undefined, { scanBook: book })
      : { ...whole!, windowsFailed: 0 };
  // G1: the PNG of each page of a book its Reader left to vision, from the
  // run of this extract's database pass, on disk. Its description is the
  // Agent's vision text of the page (no second vision call): set now when
  // the Agent has read it (a read again), else by the Agent's run.
  const bookPages = new Map<EmbeddedImage, number>();
  const pageRun = book
    ? await standingReaderPictures(ownerId, { id: node.id, sha256: data.sha256 }).catch(() => null)
    : null;
  if (pageRun) {
    for (const p of pageRun.pictures) {
      const bytes = pageRun.bytes.get(p.file);
      if (!bytes || bytes.length === 0) continue;
      const described = describeImageBytes(bytes, 'png');
      const img = {
        ...described,
        ordinal: result.images.length + 1,
        location: { page: p.page },
        ...(p.caption ? { caption: p.caption } : {}),
        // The page is the picture: no gate (a page is never an icon).
        essential: true,
      } as EmbeddedImage;
      Object.defineProperty(img, 'bytes', {
        enumerable: true,
        get: () => pageRun.bytes.get(p.file) ?? Buffer.alloc(0),
      });
      result.images.push(img);
      bookPages.set(img, p.page);
    }
  }
  const pageText =
    bookPages.size > 0
      ? await agentPageTextOf({ id: node.id, ownerId, sha256: data.sha256 })
      : null;
  // The pictures of the file the cap keeps, those it had before too.
  const keptTotal = result.images.length;
  // The pictures a file leaves out are stamped on it once the new ones are
  // saved (a save that failed is a picture not kept), and a stamp of an
  // earlier read that left none out goes (G4). Never fatal.
  const foundTotal = keptTotal + picturesLeftOutOf(result);
  const stamp = (notSaved: number) =>
    stampPicturesLeftOut(node, ownerId, result, keptTotal - notSaved, foundTotal).catch(
      (err: unknown) => {
        log('extractor').warn(`picture count not stamped: ${errorMessage(err)}`);
      },
    );
  // The pictures this file has from an earlier read keep their nodes (G5).
  if (have.size > 0) {
    result.images = result.images.filter((img) => !have.has(img.sha256));
  }
  if (result.images.length === 0) {
    await stamp(0);
    result.spool?.drop();
    if (pageRun && 'drop' in pageRun.bytes) (pageRun.bytes as SpooledPictures).drop();
  }
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
    } else if (isDrawingExt(ext)) {
      // CAD formats are different from a manual with no pictures: a drawing
      // ALWAYS has renderable content, so zero candidates means the render
      // tier failed (sidecar down/missing, render error) — invisible before
      // this step existed. Record the reason so /traces explains the missing
      // image child instead of leaving no trace at all.
      const reason = isCadExt(ext)
        ? await (await import('@mantle/files/dwg')).explainCadFileImageMiss(loaded.bytes, ext)
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

  // Extension included (90-10-01-dwg vs 90-10-01-dxf): the image names of
  // cross-format twins differ (see buildSourceSlug).
  const sourceSlug = buildSourceSlug(loaded.filename);
  const titles = buildImageTitles(result.images, node.title || loaded.filename);

  const created = await stepInOwnTrace(
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
      // One folder per file, named by its id only: a new revision has the old
      // file's name and must not hit its images, and the folder is Admin's, so
      // a file Admin cannot read must not show its name there.
      const fileKey = `file ${node.id.slice(0, 8)}${olderImages && sha ? ` ${sha.slice(0, 8)}` : ''}`;
      const folderPath = await ensureExtractedImagesFolder({
        ownerId,
        sourceSlug: fileKey,
        sourceTitle: fileKey,
      });
      // A part of the file: its home and grants, once (docs/workspaces.md).
      const saveImage = (args: Parameters<typeof upsertFile>[0]) =>
        createPartOfFile(
          node.id,
          () => upsertFile(args),
          (f) => deleteFileById({ ownerId, fileId: f.id }).then((r) => r.ok),
        );
      const createdIds: string[] = [];
      const saveErrors: string[] = [];
      for (const [i, img] of result.images.entries()) {
        const title = titles[i]!;
        try {
          const saved = await saveImage({
            ownerId,
            parentPath: folderPath,
            // Private to the file's login from its insert.
            loginId: node.loginId,
            filename: buildImageFilename(img, sourceSlug),
            bytes: img.bytes,
            title,
            tags: [EXTRACTED_IMAGE_TAG, `from:${sourceSlug}`],
            data: {
              sourceFileId: node.id,
              // The bytes it was made from: an image of another sha256 is of
              // an older version (the dedupe above).
              ...(sha ? { sourceSha256: sha } : {}),
              sourceOrdinal: img.ordinal,
              sourceTotal: keptTotal,
              ...(img.location ? { sourceLocation: img.location } : {}),
              // Which tier produced the pixels (DWF: sidecar render vs the
              // container's small preview) — the predicate the backfill's
              // --upgrade-dwf mode selects on.
              ...(img.provenance ? { provenance: img.provenance } : {}),
              // G1: a book's page picture. Its text is the Agent's vision
              // text of the page (pdf-page-read), never a vision call of its
              // own (load-body.ts); set here when the Agent has read the
              // page, else by the Agent's run (describeBookPagePictures).
              ...(bookPages.has(img)
                ? {
                    bookPage: bookPages.get(img)!,
                    ...(pageText?.get(bookPages.get(img)!)
                      ? {
                          text: pageText.get(bookPages.get(img)!)!,
                          bookPageTextSha: pageTextSha(pageText.get(bookPages.get(img)!)!),
                        }
                      : {}),
                  }
                : {}),
              extractedFrom: node.title || loaded.filename,
              // Read back by the vision path so the durable index carries the
              // document this picture came from — a bare "a screenshot of a
              // settings screen" retrieves for nobody. See composeImageBody.
              imageContext: buildImageContext({
                title,
                ordinal: img.ordinal,
                total: keptTotal,
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
  const notSaved = result.images.length - (Array.isArray(created) ? created.length : 0);
  await stamp(notSaved);
  // Every picture is saved: the pictures on disk go. A save that failed
  // keeps them for the extract's retry (the kept run is read again).
  if (notSaved === 0) {
    result.spool?.drop();
    if (pageRun && 'drop' in pageRun.bytes) (pageRun.bytes as SpooledPictures).drop();
  }
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
): Promise<{
  text: string | null;
  failure: string | null;
  /** The vision worker really read the image. False when the bytes were
   *  missing or the worker did not run (none wired, a provider error): the
   *  caller then must not stamp the node terminal. */
  ran: boolean;
}> {
  // Bytes from disk (uploads) or object storage (email image attachments).
  const loaded = await loadFileBytes(node);
  if (!loaded)
    return { text: null, failure: 'file bytes could not be read from disk or storage', ran: false };
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
        return {
          text: null,
          failure: result.note ?? 'vision worker returned no text',
          ran: result.ran,
        };
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
      return { text, failure: null, ran: true };
    },
  );
}

/** Page cap for PDF OCR — bounds rasterization memory + per-page vision spend. */
const MAX_OCR_PAGES = 10;

/**
 * The native read of a PDF that found no text, kept on the node:
 * `data.native_pdf = { empty_sha256: "<sha256 of the bytes>" }` (a read that
 * found text writes `native_pdf: true` with the text). A retry of the same
 * bytes (the render busy, a first refusal, a dead-letter redrive at api
 * boot) goes straight to the render instead of paying for the model call
 * again, whatever restarted in between. `native_pdf` is a byte-derived key
 * (BYTE_DERIVED_DATA_KEYS): new bytes drop it, and the sha256 keeps a stale
 * one from ever applying to other bytes.
 */
function nativeFoundNothing(node: typeof nodes.$inferSelect, sha: string): boolean {
  const mark = (node.data as Record<string, unknown> | null)?.native_pdf;
  return (
    !!mark && typeof mark === 'object' && (mark as { empty_sha256?: unknown }).empty_sha256 === sha
  );
}

async function rememberNativeEmpty(nodeId: string, ownerId: string, sha: string): Promise<void> {
  await db
    .update(nodes)
    .set({
      data: sql`jsonb_set(coalesce(${nodes.data}, '{}'::jsonb), '{native_pdf}', jsonb_build_object('empty_sha256', ${sha}::text))`,
    })
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)));
}

/**
 * OCR-ingest a scanned / image-only PDF file node. When a PDF has no text layer
 * (`parseDocumentBytes` yields nothing and `readNodeBodyRaw` falls back to the
 * filename), rasterize its pages to PNG and run each through the default vision
 * worker — exactly the neutral describe+OCR path images already take. The
 * concatenated text is persisted as `data.text` (+ `vision_model`, `ocr`) and
 * RETURNED so extractNode indexes it in the same pass (summary + embedding +
 * facts). Best-effort: a missing/erroring vision worker, an unrenderable PDF,
 * or a blank scan returns null and the trace records why — and the four return
 * fields keep those apart, so the caller records WHICH dead-end was hit rather
 * than collapsing them into "no text layer". Page-capped at MAX_OCR_PAGES.
 * Mirrors {@link visionIngestImageNode}.
 */
export async function ocrIngestPdfNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<{
  text: string | null;
  encrypted: boolean;
  bytesMissing: boolean;
  /** The rasterizer THREW — a corrupt PDF, a broken native binding, a pdfjs
   *  version collision. Distinct from "rendered fine, but the scan is blank":
   *  the caller must not report this as `no_text_layer`, because nothing about
   *  the document is what went wrong. Null when rasterize wasn't reached or
   *  didn't throw. */
  rasterizeError: string | null;
  /** Every page asked for was too large to render (`PdfLimitError`): a
   *  verdict on the document, so the caller records a terminal
   *  `pdf_too_large` skip rather than the retryable `pdf_unreadable`. */
  tooLarge?: string;
  /** A document or vision worker really read the PDF (native or any page).
   *  With no text, that is a blank scan: a verdict on the content. */
  ran: boolean;
}> {
  // Bytes from disk (uploads) or object storage (email PDF attachments).
  const loaded = await loadFileBytes(node);
  // bytesMissing = we couldn't retrieve the file at all (no disk path, and the
  // object isn't in storage — e.g. an email attachment indexed by metadata
  // whose body was never persisted). Distinct from "we have it but it's an
  // unreadable scan": the caller records `bytes_unavailable`, not the
  // misleading `no_text_layer`, so the operator knows to RE-FETCH not re-OCR.
  if (!loaded)
    return { text: null, encrypted: false, bytesMissing: true, rasterizeError: null, ran: false };
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
      //    A read that already ran on these bytes and found no text (kept on
      //    the node) is not paid for again: a retry after the render (the
      //    parser busy, a first refusal, a redrive after a restart) goes
      //    straight to the render.
      const bytesSha = createHash('sha256').update(buf).digest('hex');
      const knownEmpty = nativeFoundNothing(node, bytesSha);
      const native = await step(
        {
          name: 'extract_document',
          kind: 'llm_call',
          input: { mime: 'application/pdf', bytes: buf.length, known_empty: knownEmpty },
        },
        async (h) => {
          if (knownEmpty) {
            h.setMeta({ ran: true, skipped: 'read before, no text (data.native_pdf)' });
            return {
              ran: true,
              text: '',
              note: 'the native read of these bytes found no text earlier',
              model: null,
            } as Awaited<ReturnType<typeof runDocumentWorker>>;
          }
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
        return { text, encrypted: false, bytesMissing: false, rasterizeError: null, ran: true };
      }
      let ran = native.ran;
      // Kept before the render runs: the render may fail the job, and its
      // retry must not pay for this read again.
      if (native.ran && !knownEmpty) await rememberNativeEmpty(node.id, ownerId, bytesSha);

      // 2) Fall back to rasterize → per-page image OCR.
      //
      // A throw here used to be swallowed into `pages: 0`, which the caller
      // could not tell apart from a blank scan — so a broken rasterizer
      // (corrupt file, missing native binding, a second pdfjs in the process)
      // indexed the document as `no_text_layer` and told the operator to go
      // configure a vision worker. Carry the message out so the caller can be
      // honest about which of the two happened.
      let rasterizeError: string | null = null;
      let tooLarge: string | undefined;
      const pages = await step(
        { name: 'rasterize_pdf', kind: 'compute', input: { max_pages: MAX_OCR_PAGES } },
        async (h) => {
          try {
            const r = await parserRasterizePdf(buf, { maxPages: MAX_OCR_PAGES });
            h.setMeta({ pages: r.length });
            return r;
          } catch (err) {
            const msg = errorMessage(err);
            // The parser's PDF caps (declared pixels, size): a verdict on the
            // document, recorded as the terminal pdf_too_large.
            if (isParserError(err) && err.code === 'too_large') {
              tooLarge = msg;
              h.setMeta({ pages: 0, error: msg, parser_code: err.code });
              return [];
            }
            // The parser busy or unavailable, or the first time these bytes
            // timed out or crashed it: the extract fails and pg-boss retries
            // it. The second time (counted on the node, parser-failures.ts)
            // is terminal: the caller records document_unreadable. Either
            // way the native read's empty answer is kept on the node
            // (data.native_pdf), so the retry does not pay for it again.
            if (isParserError(err) && (err.retryable || err.terminal)) {
              h.setMeta({ pages: 0, error: msg, parser_code: err.code });
              throw err;
            }
            // Unrenderable / corrupt / encrypted PDF: record and give up.
            if (/password/i.test(msg)) encrypted = true;
            else rasterizeError = msg;
            h.setMeta({ pages: 0, error: msg });
            return [];
          }
        },
      );
      if (pages.length === 0)
        return {
          text: null,
          encrypted,
          bytesMissing: false,
          rasterizeError,
          ran,
          ...(tooLarge ? { tooLarge } : {}),
        };

      const parts: string[] = [];
      let model: string | null = null;
      for (const pg of pages) {
        const res = await step(
          {
            name: 'extract_vision',
            kind: 'llm_call',
            input: { page: pg.pageNumber, mime: pg.mime, bytes: pg.png.length },
          },
          async (h) => {
            const r = await runVisionWorker({
              ownerId,
              bytes: pg.png,
              mimeType: pg.mime,
              filename: `${filename}#page-${pg.pageNumber}.${pg.mime === 'image/jpeg' ? 'jpg' : 'png'}`,
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
        if (res.ran) ran = true;
        if (res.model) model = res.model;
        if (res.text.trim()) {
          parts.push(
            pages.length > 1 ? `[Page ${pg.pageNumber}]\n${res.text.trim()}` : res.text.trim(),
          );
        }
      }

      const text = cleanText(parts.join('\n\n').trim());
      if (!text) return { text: null, encrypted, bytesMissing: false, rasterizeError: null, ran }; // worker unavailable / blank scan / encrypted

      // A scan longer than the page cap is read in part: `data.ocr` then
      // says how far (`{ pages_read, pages_total }`), so the file's status
      // shows "partial" (FileRow.extraction) and not a whole read. One page
      // count of the parser, only when the cap was reached; a count that
      // fails leaves the plain `true`.
      const total =
        pages.length >= MAX_OCR_PAGES ? await parserPdfPageCount(buf).catch(() => null) : null;
      const ocrMark =
        total && total > pages.length
          ? JSON.stringify({ pages_read: pages.length, pages_total: total })
          : 'true';

      await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${model ?? ''}::text, 'ocr', ${ocrMark}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
        h.setMeta({ chars: text.length, pages: pages.length, pages_total: total });
      });
      return { text, encrypted: false, bytesMissing: false, rasterizeError: null, ran: true };
    },
  );
}

// ─── pictures: page windows and the honest count (G2, G4, G5) ─────────────

/** The sha256 of each picture already extracted from this file, of its
 *  current bytes (`current`: the dedupe's rule, file history). */
async function extractedPicturesOf(
  ownerId: string,
  fileId: string,
  current: ReturnType<typeof sql>,
): Promise<Set<string>> {
  const rows = await db
    .select({ sha: sql<string | null>`${nodes.data}->>'sha256'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sourceFileId' = ${fileId}`,
        current,
      ),
    );
  return new Set(rows.map((r) => r.sha ?? '').filter((s) => s !== ''));
}

/**
 * Stamp the pictures a file left out (G4): `data.images = { kept, found }`
 * when the cap left some out (`over_cap`, and the parser's answer budget)
 * or a page window could not be read (each such window counts as one
 * picture found and not kept, at least: its pictures are not known). A
 * file that left none out has the key taken off, so a raised cap that
 * fetched the rest clears the badge (G5). `extractionOf` reads it
 * (packages/files/src/extraction-status.ts). Byte-derived (migration 0386):
 * new bytes drop it.
 */
async function stampPicturesLeftOut(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  result: PdfPicturesRead,
  saved: number,
  found: number,
): Promise<void> {
  const kept = Math.max(0, Math.min(saved, found));
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (kept === found && data.images === undefined) return;
  // `more`: the count past the cap was cut short, so `found` is a floor.
  const next =
    kept < found
      ? sql`${nodes.data} || jsonb_build_object('images', jsonb_build_object('kept', ${kept}::int, 'found', ${found}::int, 'more', ${result.countCut === true}::boolean))`
      : sql`${nodes.data} - 'images'`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
    await tx
      .update(nodes)
      .set({ data: next })
      .where(
        and(
          eq(nodes.id, node.id),
          eq(nodes.ownerId, ownerId),
          sql`coalesce(${nodes.data}->>'sha256', '') = ${typeof data.sha256 === 'string' ? data.sha256 : ''}`,
        ),
      );
  });
}

/**
 * Stamp the pages a Reader read of a book it read in page windows (P2,
 * load-body.ts): `ocr = { pages_read, pages_total }` when a window could
 * not be read, as the OCR of a scan stamps it, so the book shows `partial`
 * (extractionOf); a book read whole carries no `ocr` (one of an older
 * read goes). Only while the node holds the bytes `sha256`. Here because
 * `ocr` is this module's key.
 */
export async function stampReaderPages(
  nodeId: string,
  ownerId: string,
  sha256: string,
  pages: { read: number; total: number },
): Promise<void> {
  await db
    .update(nodes)
    .set({
      data:
        pages.read < pages.total
          ? sql`${nodes.data} || jsonb_build_object('ocr', jsonb_build_object('pages_read', ${pages.read}::int, 'pages_total', ${pages.total}::int))`
          : sql`${nodes.data} - 'ocr'`,
    })
    .where(
      and(
        eq(nodes.id, nodeId),
        eq(nodes.ownerId, ownerId),
        sql`${nodes.data}->>'sha256' = ${sha256}`,
      ),
    );
}

// ─── G1: a book's page pictures, described by its Agent ─────────────────

/** The hash of a page text set on a page picture: an Agent's run again
 *  that read the page the same way touches nothing. */
const pageTextSha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The description of a book's page pictures (G1): the Agent pdf-page-read's
 * vision text of each page, set as the picture's `text`, and the picture
 * queued for its extract (summary and embedding of that text; no vision
 * call: load-body.ts). Called by the Agent's run (pipeline-run.ts), after
 * its rows are written: the run of an upload or of a person's
 * `pipeline_run`, never by a timer. Only a picture of a page the Agent read
 * whose text differs from the one set before. The pictures of an older
 * revision (another sha256 on the book) are left as they are.
 */
export async function describeBookPagePictures(
  ownerId: string,
  fileId: string,
  sha256: unknown,
): Promise<number> {
  if (typeof sha256 !== 'string') return 0;
  const texts = await agentPageTextOf({ id: fileId, ownerId, sha256 });
  if (texts.size === 0) return 0;
  const rows = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sourceFileId' = ${fileId}`,
        sql`${nodes.data} ? 'bookPage'`,
      ),
    );
  let described = 0;
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const page = data.bookPage;
    const text = typeof page === 'number' ? texts.get(page) : undefined;
    if (!text) continue;
    const sha = pageTextSha(text);
    if (data.bookPageTextSha === sha) continue;
    // The one door of a re-index (markContentChanged): the text is new
    // content, so the extractor runs its pass on it, announced at commit.
    await db.transaction(async (tx) => {
      await tx
        .update(nodes)
        .set({
          data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'bookPageTextSha', ${sha}::text)`,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, row.id), eq(nodes.ownerId, ownerId)));
      await markContentChanged(tx, { id: row.id, type: 'file' }, ['content']);
    });
    described += 1;
  }
  return described;
}

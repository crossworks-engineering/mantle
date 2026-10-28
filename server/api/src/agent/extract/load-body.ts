/**
 * Extractor: Reading the extractable body of a node, typed by node type.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { eq } from 'drizzle-orm';
import {
  db,
  nodes,
  emails,
  pages,
  tables,
  draws,
  presents,
  readPublishedSummary,
  type AiWorker,
} from '@mantle/db';
import {
  extOf,
  mimeForExt,
  isVisionImage,
  isParserError,
  parserText,
  parseDocumentBytes,
  INGESTABLE_EXTS,
  MEDIA_EXTS,
  parserRouteForExt,
  exportHintForExt,
  type ParserError,
} from '@mantle/files';
import { recordSkippedTrace, step } from '@mantle/tracing';
import { documentWorkerPrefersNative } from '@mantle/runtime/agent';
import { drawSceneText, foldNoteEmbeds, parseFormulaSpec, formulaToText } from '@mantle/content';
import { pageDocText, pageHolders } from '@mantle/content/pages';
import { isHollowFilenameBody } from '../extractor-parse';
import { cleanText } from './text';
import { loadFileBytes, tryUnlockPdf } from './file-bytes';
import { composeImageBody, ocrIngestPdfNode, visionIngestImageNode } from './images';
import { recordTerminalSkip, type SkipInit } from './terminal';

/** The body of a node with no model call (no vision, no OCR worker): the typed
 *  dispatch below. The cost guard's local-only index reads this. */
export async function readNodeBodyLocal(node: typeof nodes.$inferSelect): Promise<string> {
  try {
    return await readNodeBodyRaw(node);
  } catch (err) {
    // A file the parser gave up on indexes by its title here, as any
    // unreadable file does; the full pass records why (document_unreadable).
    if (isParserError(err) && err.terminal) return node.title;
    throw err;
  }
}

async function readNodeBodyRaw(node: typeof nodes.$inferSelect): Promise<string> {
  // ─── Secrets — metadata only ─────────────────────────────────────────
  // Critical security invariant: secrets pass title + description + tags
  // to the LLM, and NOTHING ELSE. The sealed value lives in the `secrets`
  // table; we never query it from this file. If you ever add a code path
  // that loads from `secrets` here, the entire threat model breaks.
  if (node.type === 'secret') {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const description = typeof data.description === 'string' ? data.description : '';
    const kind = typeof data.kind === 'string' ? data.kind : '';
    const tagLine =
      Array.isArray(node.tags) && node.tags.length > 0 ? `\n\nTags: ${node.tags.join(', ')}` : '';
    const kindLine = kind ? `\n\nKind: ${kind}` : '';
    return `${node.title}${kindLine}\n\n${description}${tagLine}`.trim();
  }
  // ─── Formulas — the spec rendered to markdown ────────────────────────
  // Indexing the raw spec JSON would bury the searchable content (the source
  // citation, the variable descriptions, the rating criteria prose) under
  // structural noise. `formulaToText` renders the parts a person would
  // actually search for. A malformed spec falls back to the title rather than
  // failing the whole extraction run.
  if (node.type === 'formula') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const parsed = parseFormulaSpec(d.spec);
    return parsed.ok ? formulaToText(parsed.spec) : node.title;
  }
  if (node.type === 'email' || node.type === 'email_thread') {
    const [row] = await db
      .select({ subject: emails.subject, bodyText: emails.bodyText, bodyHtml: emails.bodyHtml })
      .from(emails)
      .where(eq(emails.nodeId, node.id))
      .limit(1);
    if (!row) return node.title;
    let body = row.bodyText;
    // An HTML-only mail: its HTML is read by the parser service (the sync
    // keeps it as it came, packages/email/src/providers/imap.ts). The
    // parser busy or a first refusal fails the extract and it is retried;
    // a verdict on the HTML leaves the subject alone.
    if (!body?.trim() && row.bodyHtml) {
      try {
        body = (await parserText(Buffer.from(row.bodyHtml, 'utf8'), 'html')).trim();
      } catch (err) {
        if (isParserError(err) && err.retryable) throw err;
        body = null;
      }
    }
    return [row.subject, body].filter(Boolean).join('\n\n');
  }
  // ─── Tasks — body + structured metadata ──────────────────────
  // The extractor needs to know status/priority/due_at to write a useful
  // summary ("DONE: ship the secrets feature" vs "OPEN, due 2026-05-25").
  if (node.type === 'task') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    // Checklist items surface as markdown checkboxes so the summary can say
    // "3 of 5 steps done" and search hits the step text.
    const todos = Array.isArray(d.todos)
      ? (d.todos as Array<Record<string, unknown>>)
          .filter((t) => typeof t?.text === 'string' && t.text)
          .map((t) => `- [${t.done === true ? 'x' : ' '}] ${t.text as string}`)
      : [];
    const lines = [
      node.title,
      `Status: ${d.status ?? 'open'}`,
      `Priority: ${d.priority ?? 'normal'}`,
      ...(typeof d.due_at === 'string' ? [`Due: ${d.due_at}`] : []),
      ...(body ? ['', body] : []),
      ...(todos.length ? ['', ...todos] : []),
    ];
    return lines.join('\n');
  }
  // ─── Contacts — name + email/cell + the "who is this for AI" description.
  // The description carries the real semantic payload ("Modular sells aluminium
  // profiles, used for printer projects") so the extractor produces useful
  // facts + entities on the contact's identity. Keeping the structured fields
  // in the body too means search_nodes(q='@example.co.za') still hits.
  if (node.type === 'contact') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const company = typeof d.company === 'string' ? d.company : '';
    const email = typeof d.email === 'string' ? d.email : '';
    const cc = typeof d.country_code === 'string' ? d.country_code : '';
    const cell = typeof d.cell === 'string' ? d.cell : '';
    const desc = typeof d.description === 'string' ? d.description : '';
    const lines = [
      node.title,
      ...(company && company !== node.title ? [`Company: ${company}`] : []),
      ...(email ? [`Email: ${email}`] : []),
      ...(cc || cell ? [`Cell: ${cc ?? ''} ${cell ?? ''}`.trim()] : []),
      ...(desc ? ['', desc] : []),
    ];
    return lines.join('\n');
  }
  // ─── Events — title + when + where + body ────────────────────────────
  if (node.type === 'event') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    const lines = [
      node.title,
      ...(typeof d.starts_at === 'string' ? [`Starts: ${d.starts_at}`] : []),
      ...(typeof d.ends_at === 'string' ? [`Ends: ${d.ends_at}`] : []),
      ...(typeof d.location === 'string' && d.location ? [`Location: ${d.location}`] : []),
      ...(body ? ['', body] : []),
    ];
    return lines.join('\n');
  }
  // ─── Journal — two lanes: user self-knowledge / agent working notes ─────
  // User-lane entries are the user describing who they are and what they
  // expect; agent-lane entries (lesson/expectation/gap) are an agent's own
  // operational learning. The body carries the semantic payload; the framing
  // line makes the summary + facts read as durable knowledge ("works as …",
  // "the user expects …", "open question: …") rather than an event. Legacy
  // rows may carry mood/category — deliberately NOT framed anymore.
  if (node.type === 'journal') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    const kind = typeof d.kind === 'string' && d.kind ? d.kind : null;
    const agentSlug = typeof d.agent_slug === 'string' && d.agent_slug ? d.agent_slug : null;
    const framing =
      kind === 'lesson' || kind === 'expectation' || kind === 'gap'
        ? [`Working note${agentSlug ? ` from agent ${agentSlug}` : ''} (${kind})`]
        : kind
          ? [`Kind: ${kind}`]
          : [];
    const lines = [node.title, ...framing, ...(body ? ['', body] : [])];
    return lines.join('\n');
  }
  // ─── Locations — resolved place: name + address + coordinates ─────────
  if (node.type === 'location') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    const address = typeof d.address === 'string' ? d.address : '';
    const lat = typeof d.latitude === 'number' ? d.latitude : null;
    const lon = typeof d.longitude === 'number' ? d.longitude : null;
    const lines = [
      node.title,
      ...(address ? [`Address: ${address}`] : []),
      ...(lat !== null && lon !== null ? [`Coordinates: ${lat}, ${lon}`] : []),
      ...(body ? ['', body] : []),
    ];
    return lines.join('\n');
  }
  // ─── Recall maps (v2) — metadata only ────────────────────────────────
  // A `recall` node is a memory MAP; its cards are rows in recall_nodes and
  // are served through the recall tools. Indexing them here would leak
  // prompt and map text into general search and team-turn retrieval, exactly
  // what the design excludes — same posture as secrets. Title and enter-when
  // only.
  if (node.type === 'recall') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const enterWhen = typeof d.enterWhen === 'string' ? d.enterWhen.trim() : '';
    const when = enterWhen ? `\n\nEnter when: ${enterWhen}` : '';
    return `${node.title}\n\nRecall map — content served via the recall tools.${when}`.trim();
  }
  // ─── Pages — plaintext from the TipTap sidecar ────────────────────────
  // The ProseMirror doc lives in `pages.doc`. Its text is computed here from
  // the doc, the way a save computes `pages.doc_text` (pageDocText: a marker
  // per embed, filtered by the workspaces that hold it), never read from the stored
  // copy: a row saved before always fold may still hold an embed's words in
  // doc_text until the re-fold runs (workspaces plan 5.3, W2 audit).
  if (node.type === 'page') {
    const [row] = await db
      .select({ doc: pages.doc })
      .from(pages)
      .where(eq(pages.nodeId, node.id))
      .limit(1);
    if (!row) return node.title;
    const text = row.doc
      ? await pageDocText(node.ownerId, await pageHolders(node.id), row.doc)
      : '';
    return text.trim() ? text : node.title;
  }
  // ─── Tables — derived markdown from the typed-grid sidecar ────────────
  // The TableDoc lives in `tables.data`; `tables.data_text` is its markdown
  // rendering (pipe table + totals row), computed on commit in @mantle/content.
  if (node.type === 'table') {
    const [row] = await db
      .select({ dataText: tables.dataText })
      .from(tables)
      .where(eq(tables.nodeId, node.id))
      .limit(1);
    return row?.dataText?.trim() ? row.dataText : node.title;
  }
  // ─── Draws — plaintext from the Excalidraw sidecar ────────────────────
  // The scene JSON lives in `draws.scene`. Its structured plaintext (frame
  // names as headings, shape labels, bound arrows as `A -> B: label`
  // relations, a marker per placed image) is computed here the way a commit
  // computes `draws.scene_text` (drawSceneText), never read from the stored
  // copy, which may predate always fold (workspaces plan 5.3, W2 audit).
  // Only committed scenes ever reach this point: drafts never fire
  // node_ingested.
  if (node.type === 'draw') {
    const [row] = await db
      .select({ scene: draws.scene, fileRefs: draws.fileRefs })
      .from(draws)
      .where(eq(draws.nodeId, node.id))
      .limit(1);
    if (!row) return node.title;
    const text = drawSceneText((row.scene ?? {}) as Record<string, unknown>, row.fileRefs);
    return text.trim() ? text : node.title;
  }
  // ─── Presents — the canvas's derived text ─────────────────────────────
  // `presents.source_text` is the canvas's title, description and visible
  // text (content-core canvasText), written by every save. Read as stored:
  // the quiet-period flush announces a canvas only after its text settled.
  if (node.type === 'present') {
    const [row] = await db
      .select({ sourceText: presents.sourceText })
      .from(presents)
      .where(eq(presents.nodeId, node.id))
      .limit(1);
    return row?.sourceText?.trim() ? row.sourceText : node.title;
  }
  // ─── Documentation — the markdown body, cached in data.content ────────
  // Docs are synced from disk (one node per .md file). The full markdown is
  // the chunk source; the title is the collection-relative path, so the
  // hollow-title guard below would also pass — this case is explicit for
  // clarity and to keep docs off the file-bytes fallback path.
  if (node.type === 'documentation') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const content = typeof d.content === 'string' ? d.content : '';
    return content.trim() ? cleanText(content) : node.title;
  }
  // For note/file/sermon, body lives in data.content (or data.text/body).
  const data = (node.data ?? {}) as Record<string, unknown>;
  const candidates = [data.content, data.text, data.body, data.markdown];
  for (const c of candidates) {
    // Ignore a cached value that's just the title — that's the hollow
    // filename-only fallback a prior (buggy) extract may have stored; using
    // it would shortcut the real parse below and re-index nothing. Forces a
    // re-parse from disk/storage on the next run.
    if (typeof c === 'string' && c.trim().length > 0 && c.trim() !== node.title.trim())
      // A note indexes its own words and a marker per embedded file or
      // drawing, never the embed's caption (always fold, workspaces plan 5.3).
      return cleanText(node.type === 'note' ? foldNoteEmbeds(c) : c);
  }
  // file fallback: if no usable cached body, read the bytes (local disk for
  // uploads, OBJECT STORAGE for email attachments — see loadFileBytes) and
  // parse via the shared dispatcher (pdf/docx/xlsx → parser, text → UTF-8).
  // On any parse failure (encrypted/scanned/corrupt) fall through to the title.
  if (node.type === 'file') {
    const loaded = await loadFileBytes(node);
    if (loaded && INGESTABLE_EXTS.has(loaded.ext)) {
      const route = parserRouteForExt(loaded.ext);
      try {
        // Wrap the parse in a step so the trace shows WHICH reader ran, how
        // long it took and how many chars came out. Every reader but the
        // UTF-8 read is in the parser service, so the step is also where a
        // parser failure (its typed code) shows.
        const text = await step(
          {
            name: 'parse_document',
            kind: 'compute',
            input: {
              ext: loaded.ext,
              parser: route,
              bytes_in: loaded.bytes.length,
              filename: loaded.filename,
            },
          },
          async (h) => {
            const t = await parseDocumentBytes(loaded.bytes, loaded.ext);
            h.setMeta({ parser: route, chars_out: t.length, empty: t.trim().length === 0 });
            return t;
          },
        );
        if (text.trim().length > 0) return cleanText(text);
      } catch (err) {
        // The parser's verdicts that are not about the document's content:
        //  - retryable (the parser busy or restarting, or the FIRST time these
        //    bytes were too large, timed out or crashed it): the extract fails
        //    and pg-boss retries it; indexing the title now would be a false
        //    success;
        //  - terminal (the SECOND time for the same bytes): the caller
        //    records the document_unreadable skip.
        // DWG/DXF behave the same way: their CAD exchange is the parser's.
        if (isParserError(err) && (err.retryable || err.terminal)) throw err;
        // The reader refused the document (corrupt, encrypted, not what its
        // name says) or no reader takes it: the step recorded the error; fall
        // through to the title, as before.
      }
    }
  }
  return node.title;
}

/** The parser refused these bytes for the second time. */
function isTerminalParserError(err: unknown): err is ParserError {
  return isParserError(err) && err.terminal;
}

/** The owner-facing reason for a document_unreadable skip, by the parser's
 *  code. */
function unreadableHint(code: string): string {
  if (code === 'too_large')
    return 'The document is too large to read (past a size limit of the parser).';
  if (code === 'timeout') return 'Reading the document took longer than the parser allows, twice.';
  return 'Reading the document ran the parser out of memory (or crashed it), twice.';
}

/**
 * Load the FULL extracted text for a node, ready to summarise/embed/chunk.
 *
 * Covers the body-load ladder: image vision-ingest, the typed body dispatch
 * (readNodeBodyRaw), and the PDF OCR / native-read / encrypted / bytes-missing
 * / no-text-layer fallbacks. Records its OWN terminal skip traces for every
 * dead-end (no_vision_text, encrypted_pdf, bytes_unavailable, pdf_too_large,
 * pdf_unreadable, no_text_layer, body_too_short); when it does, it returns `{ ok: false }` and
 * the caller must simply return. On success returns the raw (untruncated) body
 * text.
 */
export async function loadExtractableBody(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  worker: AiWorker,
  existingData: Record<string, unknown>,
): Promise<{ ok: true; rawBody: string } | { ok: false }> {
  // Image file nodes carry no text body until a vision worker reads them.
  // The chat / Telegram upload paths do that inline, but an image dropped
  // into /files (web upload, disk-sync watcher, or MCP file_upload) arrives
  // here untouched — readNodeBodyRaw returns just the filename for it. Run the
  // default vision worker, which persists the description/OCR as data.text and
  // returns it so we index it in THIS pass below (summary + embedding + facts)
  // — no second extractor round-trip. One code path turns image bytes into
  // searchable text however the image landed. Images that already carry
  // data.text (e.g. re-extraction) fall through to readNodeBodyRaw unchanged.
  // Type/mime resolution that works for BOTH upload nodes (data.filename) and
  // email-attachment nodes (no filename — the title is the filename, mime is in
  // data.mimeType). Without this, attachments fell through every vision/OCR
  // gate and indexed as filename-only summaries.
  const fileNameForType =
    typeof existingData.filename === 'string' ? existingData.filename : node.title;
  const fileExt = extOf(fileNameForType);
  const fileMime =
    typeof existingData.mimeType === 'string' ? existingData.mimeType : mimeForExt(fileExt);

  // Formats we can identify but deliberately can't read, where the fix is an
  // export rather than a retry or a code change (Microsoft Project today).
  // Caught HERE, ahead of the whole parser ladder, because the alternative is
  // worse than a refusal: with no parser for the extension, the ladder returns
  // an empty string, the body falls back to the filename, and the node indexes
  // as a plausible-looking success. The user believes their plan is in the
  // brain, nothing ever contradicts them, and the failure is discovered only
  // when an answer is quietly wrong. An honest terminal skip that names the
  // export is the whole point.
  // The parser refused these bytes twice (parser-client.ts): terminal, so the
  // drain does not re-queue the node until it changes.
  const unreadable = async (err: ParserError): Promise<{ ok: false }> => {
    await recordTerminalSkip(
      {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'document_unreadable',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          extension: fileExt,
          parser_code: err.code,
          hint: `${unreadableHint(err.code)} ${err.message}. The file stays stored and findable by its name.`,
        },
      },
      node,
    );
    return { ok: false };
  };

  const exportHint = node.type === 'file' ? exportHintForExt(fileExt) : undefined;
  if (exportHint) {
    await recordTerminalSkip(
      {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'needs_export',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          extension: fileExt,
          hint: exportHint,
        },
      },
      node,
    );
    return { ok: false };
  }

  // Audio / video: stored and playable, but no parser can read them and
  // transcription is an explicit paid action (the video_ingest tool), never
  // something this sweep triggers on its own. Refuse HERE, before any byte
  // read, for the same reason as needs_export above: without this the ladder
  // falls through to the filename, and a descriptively-named recording
  // ("standup-recording-2026-08-20.mp4") clears the ≥20-char body check and
  // indexes its own filename as if it were the document — a false success the
  // user only discovers when an answer is quietly wrong. The `!text/!content`
  // guard keeps a media node that DOES carry stored text (a future transcript
  // stamped onto it) indexable.
  const isMediaFile =
    MEDIA_EXTS.has(fileExt) ||
    // Extension alone misses email attachments, whose filename lives in the
    // TITLE ('Voice Message') while the truth is in data.mimeType — resolved
    // into fileMime above for exactly this case.
    fileMime.startsWith('audio/') ||
    fileMime.startsWith('video/');
  if (node.type === 'file' && !existingData.text && !existingData.content && isMediaFile) {
    await recordTerminalSkip(
      {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'unsupported_media',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          extension: fileExt,
          mime: fileMime,
          hint: 'Audio/video files are stored and playable but not indexed. To get a searchable transcript, ask the assistant to transcribe this file (video_ingest with its file id). The file stays findable by name.',
        },
      },
      node,
    );
    return { ok: false };
  }

  // isVisionImage: EXT routing beats the client-supplied mime — uploaders
  // send `image/vnd.dwg` for DWGs, and following that mime shipped the CAD
  // binary to the vision worker (empty read → false `no_vision_text` skip)
  // instead of the dwg parser route.
  const isImageNeedingVision =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    isVisionImage(fileExt, fileMime);

  // Read the FULL extracted text once. `body` (truncated) is what the LLM
  // sees; `rawBody` is what we persist so the document stays retrievable.
  let rawBody: string;
  if (isImageNeedingVision) {
    const vision = await visionIngestImageNode(node, ownerId);
    if (!vision.text) {
      // Vision produced no text — an SVG/vector the model can't read, a blank
      // image, or an unwired/erroring vision worker. Record a TERMINAL skip so
      // the node counts as processed. Without this it has only a `photo_ingest`
      // trace and no `extractor_run`, so the periodic extract sweep — whose
      // loop-safety keys on the presence of an extractor_run — re-queues it
      // every cycle forever (the icon.svg "indexed every minute" bug).
      // Terminal only when the worker really read the image and found
      // nothing: a worker that did not run (none wired, a provider error) is
      // left for the drain to retry once it is back.
      const skip: SkipInit = {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'no_vision_text',
        details: {
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          mime: fileMime,
          // The ACTUAL reason, not a guess — a wrong model id on the vision
          // worker used to surface as this generic skip while the provider's
          // 404 vanished (2026-08-31: nine drawing sheets, three debugging
          // rounds). The worker's failure note names it now.
          vision_failure: vision.failure,
          hint: `Image produced no describable text — ${vision.failure ?? 'the model returned empty output for this image'}. Nothing to index; the node is marked processed so the sweep stops re-queuing it.`,
        },
      };
      await (vision.ran ? recordTerminalSkip(skip, node) : recordSkippedTrace(skip));
      return { ok: false };
    }
    // An extracted document image carries a provenance header; folding it in
    // here means the summary, embedding and chunks all know which manual and
    // which step this picture belongs to. A no-op for ordinary photos.
    rawBody = composeImageBody(existingData, vision.text);
  } else {
    try {
      rawBody = await readNodeBodyRaw(node);
    } catch (err) {
      if (!isTerminalParserError(err)) throw err;
      return unreadable(err);
    }
  }

  // Scanned / image-only PDF: readNodeBodyRaw found no text layer and fell back
  // to the title (filename). Indexing that would silently mask the failure — a
  // filename-only summary recorded as `success` (the passport-PDF case). Before
  // giving up, try OCR via the vision worker (rasterize → describe+OCR), the
  // same route images take. Only triggered when the body IS the filename, so a
  // PDF with a real text layer never pays the OCR cost.
  const isPdf = fileExt === 'pdf' || fileMime === 'application/pdf';
  const isPdfWithoutTextLayer =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    isPdf &&
    rawBody.trim() === node.title.trim();
  // prefer_native: a PDF WITH a text layer, but the document worker is set to
  // always read PDFs through the model (tabular docs whose text layer scrambles
  // columns). Run the same native path; keep the text-layer body if native
  // yields nothing, so we never end up worse than the cheap path.
  const isPdfWithTextLayer =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    isPdf &&
    !isPdfWithoutTextLayer;
  const preferNativePdf = isPdfWithTextLayer && (await documentWorkerPrefersNative(ownerId));

  if (isPdfWithoutTextLayer) {
    let ocr: Awaited<ReturnType<typeof ocrIngestPdfNode>>;
    try {
      ocr = await ocrIngestPdfNode(node, ownerId);
    } catch (err) {
      if (!isTerminalParserError(err)) throw err;
      return unreadable(err);
    }
    if (ocr.text && ocr.text.trim().length >= 20) {
      rawBody = ocr.text;
    } else if (ocr.encrypted) {
      // Password-protected PDF. Try the vaulted passwords before giving up.
      let unlocked: string | null;
      try {
        unlocked = await tryUnlockPdf(node, ownerId);
      } catch (err) {
        if (!isTerminalParserError(err)) throw err;
        return unreadable(err);
      }
      if (unlocked && unlocked.trim().length >= 20) {
        rawBody = unlocked;
      } else {
        // No stored password opened it. Honest, distinct skip (not the
        // misleading no_text_layer) so the operator knows it's LOCKED, not blank.
        await recordTerminalSkip(
          {
            kind: 'extractor_run',
            ownerId,
            subjectId: node.id,
            subjectKind: 'node',
            disposition: 'encrypted_pdf',
            details: {
              worker_slug: worker.slug,
              node_type: node.type,
              title: node.title,
              filename: existingData.filename,
              hint: 'PDF is password-protected and no stored password opened it. Add the password at /settings/pdf-passwords, then re-extract.',
            },
          },
          node,
        );
        return { ok: false };
      }
    } else if (ocr.bytesMissing) {
      // We never had the file's bytes (no disk path + not in object storage —
      // e.g. an email attachment indexed by metadata whose body was never
      // fetched). Distinct from a bad scan: the fix is to RE-FETCH the file,
      // not to OCR it. Honest disposition so the operator can tell the two apart.
      await recordTerminalSkip(
        {
          kind: 'extractor_run',
          ownerId,
          subjectId: node.id,
          subjectKind: 'node',
          disposition: 'bytes_unavailable',
          details: {
            worker_slug: worker.slug,
            node_type: node.type,
            title: node.title,
            filename: existingData.filename,
            sha256: typeof existingData.sha256 === 'string' ? existingData.sha256 : undefined,
            hint: "The file's bytes aren't in object storage (metadata-only node — e.g. an email attachment whose body was never fetched). Re-fetch the source to extract it; OCR can't help.",
          },
        },
        node,
      );
      return { ok: false };
    } else if (ocr.tooLarge) {
      // Every page was past a render limit, or the file past the size limit
      // (the parser's PDF reader, packages/files/src/pdf-open.ts). The
      // same bytes give the same answer, so this is a verdict on the document
      // and terminal: retrying it is how one oversized upload became a
      // restart loop before the limits existed.
      await recordTerminalSkip(
        {
          kind: 'extractor_run',
          ownerId,
          subjectId: node.id,
          subjectKind: 'node',
          disposition: 'pdf_too_large',
          details: {
            worker_slug: worker.slug,
            node_type: node.type,
            title: node.title,
            filename: existingData.filename,
            error: ocr.tooLarge,
            hint: 'The PDF has no text layer and is too large to render for OCR: its pages, an embedded image on them, or the file itself (see `error`). Re-export it at a normal size, then re-extract.',
          },
        },
        node,
      );
      return { ok: false };
    } else if (ocr.rasterizeError) {
      // The rasterizer THREW. Nothing is wrong with the document as far as we
      // know — the machinery failed — so `no_text_layer` would be a lie, and
      // its hint ("configure a default vision worker") would send the operator
      // to fix something that isn't broken. The error text goes in the details
      // because it is the whole diagnosis: a corrupt file reads differently
      // from a missing native binding, which reads differently again from two
      // pdfjs copies in one process (an API/Worker version mismatch, which
      // poisons EVERY later PDF in that worker until it restarts).
      await recordSkippedTrace({
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'pdf_unreadable',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          error: ocr.rasterizeError,
          hint: 'Rasterizing the PDF for OCR threw — see `error`. This is a failure of the PDF pipeline, not a verdict on the document: the file may well be fine. A version-mismatch error means the process holds two pdfjs copies and every later PDF will fail until it restarts; otherwise suspect a corrupt file or a broken native binding.',
        },
      });
      return { ok: false };
    } else {
      // No text layer AND OCR produced nothing (no/unwired vision worker, or a
      // blank scan — an unrenderable PDF is `pdf_unreadable` above). Record an
      // honest skip instead of a filename-only false success.
      // Terminal only when a worker really read the pages (a blank scan); no
      // worker, or one that failed, is left for the drain to retry.
      const skip: SkipInit = {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'no_text_layer',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          hint: 'PDF has no extractable text layer and OCR produced nothing — configure a default vision worker at /settings/ai-workers, or re-upload as an image. A blank/illegible scan can also land here. (A PDF that failed to RENDER is recorded as pdf_unreadable instead.)',
        },
      };
      await (ocr.ran ? recordTerminalSkip(skip, node) : recordSkippedTrace(skip));
      return { ok: false };
    }
  } else if (preferNativePdf) {
    // The text layer is already in hand: whatever the native read or the
    // parser does here (busy, a timeout, a refusal), the body is kept and the
    // job goes on. It never fails or retries the job, so the native read is
    // never paid for twice on its account.
    let native: Awaited<ReturnType<typeof ocrIngestPdfNode>> | null;
    try {
      native = await ocrIngestPdfNode(node, ownerId);
    } catch (err) {
      if (!isParserError(err)) throw err;
      native = null;
    }
    // Only replace the text-layer body if native produced something usable;
    // otherwise keep the text we already have (native is best-effort here).
    if (native?.text && native.text.trim().length >= 20) rawBody = native.text;
  }

  // Generalised hollow-body guard. readNodeBodyRaw falls back to the TITLE for
  // any file no parser handles, and the ≥20-char check below was the only gate
  // — so a file with a long descriptive name indexed its own filename as the
  // document and the trace said success. The PDF branch above catches this for
  // PDFs (isPdfWithoutTextLayer); this catches every OTHER parserless format,
  // including ones added in the future. Media never reaches here (refused
  // early, unsupported_media); images never reach here (vision path above
  // returns on both outcomes). Predicate is pure + tested in extractor-parse.
  if (
    node.type === 'file' &&
    isHollowFilenameBody({
      mime: fileMime,
      parserRoute: parserRouteForExt(fileExt),
      rawBody,
      title: node.title,
    })
  ) {
    await recordTerminalSkip(
      {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'no_parser',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          extension: fileExt,
          // CAD routes land here only on a SNIFF MISS (the bytes are not that
          // format — a renamed DWFx, a mislabelled file); "no parser reads
          // .dwg" would be false, and a parser failure never reaches this
          // guard (it throws upstream as a real, retryable extract error).
          hint:
            fileExt === 'dwg' || fileExt === 'dxf' || fileExt === 'dwf'
              ? `The file is named .${fileExt} but does not contain readable ${fileExt.toUpperCase()} data (a renamed or mislabelled format?). Nothing to index beyond the filename — re-export it from the CAD tool and re-upload.`
              : parserRouteForExt(fileExt) === 'legacy-sheet'
                ? `The .${fileExt} workbook could not be converted for reading (an unusual or damaged legacy file). Nothing to index beyond the filename: re-save it as .xlsx and re-upload.`
                : `No parser reads .${fileExt || 'unknown'} files, so there is nothing to index beyond the filename. Convert the file to a supported format (pdf, docx, xlsx, text) and re-upload to make its content searchable.`,
        },
      },
      node,
    );
    return { ok: false };
  }

  // A published summary (Journal v3 J9: an app's or a canvas's, its
  // author's or its publish's) leads the body: a drawing-heavy canvas has
  // few words of its own, so its passages, facts and entities then come
  // from what the summary says it shows, and it is never too short to index.
  const published = readPublishedSummary(existingData);
  if (published && !(rawBody ?? '').includes(published.text)) {
    rawBody = `${published.text}\n\n${rawBody ?? ''}`.trim();
  }

  if (!rawBody || rawBody.trim().length < 20) {
    // Not enough content to extract meaningfully.
    await recordTerminalSkip(
      {
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'body_too_short',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          body_chars: rawBody?.length ?? 0,
          threshold_chars: 20,
          hint: 'The extractor wants ≥20 chars of body content. Title-only nodes are skipped.',
        },
      },
      node,
    );
    return { ok: false };
  }
  return { ok: true, rawBody };
}

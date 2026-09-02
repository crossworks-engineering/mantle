/**
 * Extractor: Reading the extractable body of a node, typed by node type.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { eq } from 'drizzle-orm';
import { db, nodes, emails, pages, tables, draws, type AiWorker } from '@mantle/db';
import {
  extOf,
  mimeForExt,
  isVisionImage,
  parseDocumentBytes,
  INGESTABLE_EXTS,
  MEDIA_EXTS,
  parserRouteForExt,
  exportHintForExt,
} from '@mantle/files';
import { recordSkippedTrace, step } from '@mantle/tracing';
import { documentWorkerPrefersNative } from '@mantle/agent-runtime';
import { parseFormulaSpec, formulaToText, isRecallTreePage } from '@mantle/content';
import { isHollowFilenameBody } from '../extractor-parse';
import { cleanText } from './text';
import { loadFileBytes, tryUnlockPdf } from './file-bytes';
import { composeImageBody, ocrIngestPdfNode, visionIngestImageNode } from './images';

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
      .select({ subject: emails.subject, bodyText: emails.bodyText })
      .from(emails)
      .where(eq(emails.nodeId, node.id))
      .limit(1);
    if (!row) return node.title;
    return [row.subject, row.bodyText].filter(Boolean).join('\n\n');
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
  // in the body too means search_nodes(q='@modular.co.za') still hits.
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
  // ─── Pages — derived plaintext from the TipTap sidecar ───────────────
  // The ProseMirror doc lives in `pages.doc`; `pages.doc_text` is its
  // flattened plaintext, computed on every save in @mantle/content.
  if (node.type === 'page') {
    // ─── Recall maps — metadata only ───────────────────────────────────
    // A page inside a `recall`-tagged tree is SERVED through the compiled
    // recall_nodes rows (docs/recall.md); indexing its body here would leak
    // prompt/map text into general search and team-turn retrieval, exactly
    // what the design excludes. Title + tags only — same posture as secrets.
    if (await isRecallTreePage(node.ownerId, node.id)) {
      const tagLine =
        Array.isArray(node.tags) && node.tags.length > 0 ? `\n\nTags: ${node.tags.join(', ')}` : '';
      return `${node.title}\n\nRecall map page — content served via the recall tools.${tagLine}`.trim();
    }
    const [row] = await db
      .select({ docText: pages.docText })
      .from(pages)
      .where(eq(pages.nodeId, node.id))
      .limit(1);
    return row?.docText?.trim() ? row.docText : node.title;
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
  // ─── Draws — derived plaintext from the Excalidraw sidecar ────────────
  // The scene JSON lives in `draws.scene`; `draws.scene_text` is its
  // structured plaintext (frame names as headings, shape labels, bound
  // arrows as `A -> B: label` relations), computed on commit in
  // @mantle/content. Only committed scenes ever reach this point — drafts
  // never fire node_ingested.
  if (node.type === 'draw') {
    const [row] = await db
      .select({ sceneText: draws.sceneText })
      .from(draws)
      .where(eq(draws.nodeId, node.id))
      .limit(1);
    return row?.sceneText?.trim() ? row.sceneText : node.title;
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
      return cleanText(c);
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
        // Wrap the parse in a step so the trace shows WHICH tier ran
        // (pdf-parse / mammoth / exceljs / legacy-sheet / utf8 / tika), how long it took,
        // and how many chars came out. Particularly important for Tika
        // since it's an HTTP call with its own failure modes (service down,
        // timeout, unparseable bytes — all swallowed to '' by design); the
        // step makes Tika invisible→visible without changing behaviour.
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
        // DWG/DXF have NO local parser: a throw here means the media sidecar
        // is missing or the exchange failed — a title fallback would record a
        // terminal `no_parser` skip telling the user to convert the file,
        // which is false (the fix is enabling the CAD tier). Rethrow so the
        // extract errors for real and pg-boss retries heal the node.
        if (route === 'dwg' || route === 'dxf') throw err;
        // Parse / read failed. The step (if it opened) already recorded the
        // error; fall through to the title.
      }
    }
  }
  return node.title;
}

/**
 * Load the FULL extracted text for a node, ready to summarise/embed/chunk.
 *
 * Covers the body-load ladder: image vision-ingest, the typed body dispatch
 * (readNodeBodyRaw), and the PDF OCR / native-read / encrypted / bytes-missing
 * / no-text-layer fallbacks. Records its OWN terminal skip traces for every
 * dead-end (no_vision_text, encrypted_pdf, bytes_unavailable, no_text_layer,
 * body_too_short); when it does, it returns `{ ok: false }` and the caller must
 * simply return. On success returns the raw (untruncated) body text.
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
  const exportHint = node.type === 'file' ? exportHintForExt(fileExt) : undefined;
  if (exportHint) {
    await recordSkippedTrace({
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
    });
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
    await recordSkippedTrace({
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
        hint: "Audio/video files are stored and playable but not indexed yet. To get a searchable transcript, ask the assistant to ingest the video's link (video_ingest). The file stays findable by name.",
      },
    });
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
      await recordSkippedTrace({
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
      });
      return { ok: false };
    }
    // An extracted document image carries a provenance header; folding it in
    // here means the summary, embedding and chunks all know which manual and
    // which step this picture belongs to. A no-op for ordinary photos.
    rawBody = composeImageBody(existingData, vision.text);
  } else {
    rawBody = await readNodeBodyRaw(node);
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
    const ocr = await ocrIngestPdfNode(node, ownerId);
    if (ocr.text && ocr.text.trim().length >= 20) {
      rawBody = ocr.text;
    } else if (ocr.encrypted) {
      // Password-protected PDF. Try the vaulted passwords before giving up.
      const unlocked = await tryUnlockPdf(node, ownerId);
      if (unlocked && unlocked.trim().length >= 20) {
        rawBody = unlocked;
      } else {
        // No stored password opened it. Honest, distinct skip (not the
        // misleading no_text_layer) so the operator knows it's LOCKED, not blank.
        await recordSkippedTrace({
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
        });
        return { ok: false };
      }
    } else if (ocr.bytesMissing) {
      // We never had the file's bytes (no disk path + not in object storage —
      // e.g. an email attachment indexed by metadata whose body was never
      // fetched). Distinct from a bad scan: the fix is to RE-FETCH the file,
      // not to OCR it. Honest disposition so the operator can tell the two apart.
      await recordSkippedTrace({
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
      });
      return { ok: false };
    } else {
      // No text layer AND OCR produced nothing (no/unwired vision worker, an
      // unrenderable PDF, or a blank scan). Record an honest skip instead of a
      // filename-only false success.
      await recordSkippedTrace({
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
          hint: 'PDF has no extractable text layer and OCR produced nothing — configure a default vision worker at /settings/ai-workers, or re-upload as an image. A blank/illegible scan can also land here.',
        },
      });
      return { ok: false };
    }
  } else if (preferNativePdf) {
    const native = await ocrIngestPdfNode(node, ownerId);
    // Only replace the text-layer body if native produced something usable;
    // otherwise keep the text we already have (native is best-effort here).
    if (native.text && native.text.trim().length >= 20) rawBody = native.text;
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
    await recordSkippedTrace({
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
        // .dwg" would be false, and a sidecar failure never reaches this
        // guard (it throws upstream as a real, retryable extract error).
        hint:
          fileExt === 'dwg' || fileExt === 'dxf' || fileExt === 'dwf'
            ? `The file is named .${fileExt} but does not contain readable ${fileExt.toUpperCase()} data (a renamed or mislabelled format?). Nothing to index beyond the filename — re-export it from the CAD tool and re-upload.`
            : `No parser reads .${fileExt || 'unknown'} files, so there is nothing to index beyond the filename. Convert the file to a supported format (pdf, docx, xlsx, text) and re-upload to make its content searchable.`,
      },
    });
    return { ok: false };
  }

  if (!rawBody || rawBody.trim().length < 20) {
    // Not enough content to extract meaningfully.
    await recordSkippedTrace({
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
    });
    return { ok: false };
  }
  return { ok: true, rawBody };
}

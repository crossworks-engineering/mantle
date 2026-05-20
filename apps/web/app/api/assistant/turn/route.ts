/**
 * /api/assistant/turn — the web assistant's main inbound channel.
 *
 * Accepts EITHER:
 *   - application/json: { text }                          (text-only turn)
 *   - multipart/form-data: text + image|file (optional)   (attachment)
 *
 * Attachments are saved as a file node under
 * /files/assistant-uploads/<yyyy-mm-dd>/ (persistent + searchable), then
 * their text is folded into the user message so the LLM can answer:
 *   - images → default vision worker transcribes/answers (question-aware);
 *   - documents (pdf/docx/xlsx/csv/txt/md/json/yaml) → parsed to text via
 *     the @mantle/files parsers.
 * Either way the saved file node id is surfaced in the prompt so Saskia can
 * re-read the original (extract_from_image / file_read) on a follow-up.
 *
 * Extraction failures don't kill the turn — we fall back with a marker like
 * "[File attached but couldn't be read: <reason>]" so Saskia at least knows
 * the user TRIED to share something.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { runAssistantTurn } from '@/lib/assistant';
import { getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { getVisionAdapter } from '@mantle/voice';
import {
  ensureDatedUploadFolder,
  extOf,
  mimeForExt,
  transcodeImageForVision,
  upsertFile,
  INGESTABLE_EXTS,
} from '@mantle/files';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({ text: z.string().min(1).max(20_000) });

const ASSISTANT_UPLOADS_SLUG = 'assistant-uploads';
const IMAGE_MIME_PREFIX = 'image/';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB — generous; Anthropic vision caps at 5 MB
// Max chars of parsed document text folded into the responder prompt. The
// FULL text is persisted on the node + indexed by the extractor; the turn
// only needs a workable slice (file_read fetches the rest on demand).
const DOC_TEXT_MAX = 24_000;

/** Save the uploaded image to /files/assistant-uploads/<date>/ and
 *  run the default vision worker over it. Returns the extracted text
 *  + the saved nodeId so the turn endpoint can attach both as
 *  artifact metadata and inject the transcript into the LLM prompt.
 *  On worker failure returns a string error in `note` so the caller
 *  can still proceed with a degraded message. */
async function processUploadedImage(
  ownerId: string,
  bytes: Buffer,
  mimeType: string,
  originalName: string,
  userText: string,
): Promise<{
  nodeId: string | null;
  storagePath: string | null;
  extractedText: string;
  note: string | null;
  imageArtifact: ToolArtifact | null;
}> {
  // Persist first — even if vision fails we want the image in Files.
  let nodeId: string | null = null;
  let storagePath: string | null = null;
  try {
    const parentPath = await ensureDatedUploadFolder({
      ownerId,
      topSlug: ASSISTANT_UPLOADS_SLUG,
      topDescription: 'Files uploaded through the /assistant chat. Auto-created.',
    });
    const ext = mimeType.split('/')[1] ?? 'png';
    const safeBase = originalName
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w-]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '');
    const filename = `${Date.now()}-${safeBase || 'upload'}.${ext}`;
    const file = await upsertFile({
      ownerId,
      parentPath,
      filename,
      bytes,
      overwrite: false,
    });
    nodeId = file.id;
    storagePath = `${parentPath}/${filename}`;
    // Trace the upload as an ingest event so the new file's
    // biography page picks up the entry point. Vision worker runs
    // separately (extractor_run trace) after this and joins via
    // pg_notify on the new node.
    void recordIngest({
      source: 'assistant_upload',
      ownerId,
      nodeId: file.id,
      summary: `Image uploaded via /assistant: ${originalName}`,
      payload: {
        parentPath,
        filename,
        mimeType,
        sizeBytes: file.sizeBytes,
        originalName,
        via: 'web_assistant_chat',
      },
    });
  } catch (err) {
    // File save failure is loggable but not fatal — vision can still
    // run on the bytes we have in memory.
    console.warn('[assistant/turn] upload save failed:', err);
  }

  // Echo the image back as an inbound artifact so the client can
  // render the user's bubble with the picture they just sent. The
  // turn endpoint surfaces this on the inbound message.
  const imageArtifact: ToolArtifact = {
    kind: 'image',
    mimeType,
    base64: bytes.toString('base64'),
    caption: originalName,
    ...(nodeId ? { nodeId } : {}),
    producedBy: 'assistant-upload',
  };

  const worker = await getDefaultWorker(ownerId, 'vision');
  if (!worker?.apiKeyId) {
    return {
      nodeId,
      storagePath,
      extractedText: '',
      note: 'No default vision worker configured — image attached but not transcribed.',
      imageArtifact,
    };
  }
  const adapter = getVisionAdapter(worker.provider);
  if (!adapter) {
    return {
      nodeId,
      storagePath,
      extractedText: '',
      note: `Vision provider '${worker.provider}' isn't wired.`,
      imageArtifact,
    };
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    return {
      nodeId,
      storagePath,
      extractedText: '',
      note: `Vision worker '${worker.slug}' api_key could not be decrypted.`,
      imageArtifact,
    };
  }

  const params = (worker.params ?? {}) as {
    extraction_prompt?: string;
    max_tokens?: number;
  };
  const ocrPrompt =
    params.extraction_prompt?.trim() ||
    "Describe what's in this image in one or two sentences — the main subject, objects, logos, people, or scene. Then, if the image contains any text, transcribe it verbatim below the description (preserve line breaks; mark anything unclear as [unclear]). If there's no text, the description alone is enough. Output plain text only.";
  // Prompt-switch: when the user asked something alongside the image,
  // answer THAT (visual Q&A — "what car logo is this"). With no question
  // it's passive ingest, so fall back to the OCR/transcription prompt and
  // still build searchable metadata from the photo.
  const question = userText.trim();
  const prompt = question
    ? `The user sent this image and asked: "${question}"\n\nAnswer their question directly and specifically, grounded only in what's actually visible in the image — don't invent details you can't see. Then add one short line describing the image overall, so this also serves as a useful record of the photo.`
    : ocrPrompt;
  try {
    // Vision providers can't read HEIC (iPhone default) — transcode to JPEG
    // first. Passthrough for everything else.
    const forVision = await transcodeImageForVision(bytes, mimeType, originalName);
    const result = await adapter.extract(forVision.bytes, {
      apiKey,
      mimeType: forVision.mimeType,
      prompt,
      systemPrompt: worker.systemPrompt ?? undefined,
      model: worker.model,
      maxTokens: params.max_tokens ?? 2000,
    });
    // Persist the vision output as the image node's searchable text so
    // the photo becomes findable in the brain — the extractor skips raw
    // images (no OCR there), so without this the picture's content is
    // lost. Re-fire node_ingested so the extractor summarises + embeds +
    // extracts facts from what the vision worker saw. Best-effort.
    if (nodeId && result.text.trim().length > 0) {
      try {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${result.text}::text, 'vision_model', ${worker.model}::text)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)));
        await db.execute(sql`SELECT pg_notify('node_ingested', ${nodeId}::text)`);
      } catch (err) {
        console.warn('[assistant/turn] persist vision text failed:', err);
      }
    }
    return {
      nodeId,
      storagePath,
      extractedText: result.text,
      note: null,
      imageArtifact,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      nodeId,
      storagePath,
      extractedText: '',
      note: `Vision worker failed: ${msg}`,
      imageArtifact,
    };
  }
}

/** Save an uploaded document to /files/assistant-uploads/<date>/ and parse
 *  its text via the @mantle/files parsers. Returns the extracted text +
 *  saved nodeId so the turn folds the text into the prompt. On a parse
 *  failure returns a `note` so the caller proceeds with a degraded message.
 *  The file node fires node_ingested → the extractor indexes the full text
 *  for later search; this just gets the responder enough to answer now. */
async function processUploadedDocument(
  ownerId: string,
  bytes: Buffer,
  originalName: string,
): Promise<{ nodeId: string | null; extractedText: string; note: string | null }> {
  const ext = extOf(originalName);
  let nodeId: string | null = null;
  try {
    const parentPath = await ensureDatedUploadFolder({
      ownerId,
      topSlug: ASSISTANT_UPLOADS_SLUG,
      topDescription: 'Files uploaded through the /assistant chat. Auto-created.',
    });
    const safeBase = originalName
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w-]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '');
    const filename = `${Date.now()}-${safeBase || 'upload'}.${ext || 'bin'}`;
    const file = await upsertFile({ ownerId, parentPath, filename, bytes, overwrite: false });
    nodeId = file.id;
    void recordIngest({
      source: 'assistant_upload',
      ownerId,
      nodeId: file.id,
      summary: `File uploaded via /assistant: ${originalName}`,
      payload: { parentPath, filename, ext, sizeBytes: file.sizeBytes, originalName, via: 'web_assistant_chat' },
    });
  } catch (err) {
    console.warn('[assistant/turn] document save failed:', err);
  }

  let text = '';
  let note: string | null = null;
  try {
    if (ext === 'pdf') {
      const { parsePdf } = await import('@mantle/files/pdf');
      text = await parsePdf(bytes);
    } else if (ext === 'docx') {
      const { parseDocx } = await import('@mantle/files/docx');
      text = await parseDocx(bytes);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const { parseXlsx } = await import('@mantle/files/xlsx');
      text = await parseXlsx(bytes);
    } else {
      // csv / txt / md / json / yaml — plain UTF-8.
      text = bytes.toString('utf8');
    }
  } catch (err) {
    console.warn('[assistant/turn] document parse failed:', err);
    note = `Couldn't parse the ${ext.toUpperCase()} (scanned, encrypted, or corrupt?).`;
    text = '';
  }

  text = text.trim();
  if (!text) {
    return { nodeId, extractedText: '', note: note ?? `No text could be extracted from ${originalName}.` };
  }
  // Bound the prompt cost — full text is on the node + indexed; file_read
  // fetches the rest.
  const extractedText =
    text.length > DOC_TEXT_MAX
      ? `${text.slice(0, DOC_TEXT_MAX)}\n\n[...truncated ${text.length - DOC_TEXT_MAX} more characters — call file_read on the node for the full document.]`
      : text;
  return { nodeId, extractedText, note };
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const contentType = req.headers.get('content-type') ?? '';

  let userText = '';
  // Unified attachment context across image + document paths.
  let attachment:
    | {
        kind: 'image' | 'file';
        nodeId: string | null;
        extractedText: string;
        note: string | null;
        imageArtifact: ToolArtifact | null;
      }
    | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
    }
    userText = ((form.get('text') as string | null) ?? '').trim();
    // Images arrive under 'image', documents under 'file'; accept either.
    const file = form.get('image') ?? form.get('file');
    if (file instanceof Blob && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `attachment too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
          { status: 413 },
        );
      }
      // Form's File interface has a name; plain Blob doesn't.
      const originalName =
        'name' in file && typeof (file as File).name === 'string'
          ? (file as File).name
          : 'upload';
      const ext = extOf(originalName);
      const isImage = file.type.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(ext).startsWith('image/');
      const bytes = Buffer.from(await file.arrayBuffer());
      if (isImage) {
        // userText is the raw typed text (before the no-text default below)
        // so the vision worker answers the real question when there is one.
        const r = await processUploadedImage(
          user.id,
          bytes,
          file.type || mimeForExt(ext),
          originalName,
          userText,
        );
        attachment = { kind: 'image', ...r };
      } else if (INGESTABLE_EXTS.has(ext)) {
        const r = await processUploadedDocument(user.id, bytes, originalName);
        attachment = { kind: 'file', ...r, imageArtifact: null };
      } else {
        return NextResponse.json(
          {
            error:
              `unsupported file type '${file.type || ext || 'unknown'}'. ` +
              'Supported: images, and documents (pdf, docx, xlsx, csv, txt, md, json, yaml).',
          },
          { status: 415 },
        );
      }
    }
    if (!userText && !attachment) {
      return NextResponse.json(
        { error: 'either text or an attachment must be provided' },
        { status: 400 },
      );
    }
    // If only an attachment was sent with no text, give the LLM a default
    // prompt so it has something to react to.
    if (!userText && attachment) {
      userText =
        attachment.kind === 'image'
          ? "Here's an image — tell me what you see."
          : "I've attached a file — take a look and tell me what's in it.";
    }
  } else {
    const raw = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'invalid input' },
        { status: 400 },
      );
    }
    userText = parsed.data.text;
  }

  try {
    // Hand the turn the attachment's extracted text (+ the raw image for a
    // vision-capable responder). The runtime is transcript-default: it folds
    // the text in and only inlines raw pixels when there's no transcript.
    // The persisted inbound row shows the user's own typed text (displayText).
    const { inbound, outbound, reply, artifacts } = await runAssistantTurn(
      user.id,
      userText,
      attachment
        ? {
            displayText: userText,
            attachmentKind: attachment.kind,
            image: attachment.imageArtifact
              ? {
                  base64: attachment.imageArtifact.base64,
                  mimeType: attachment.imageArtifact.mimeType,
                }
              : undefined,
            imageTranscript: attachment.extractedText || undefined,
            imageNote: attachment.note || undefined,
            imageNodeId: attachment.nodeId || undefined,
          }
        : undefined,
    );
    // Forward an inbound image artifact so the user's bubble shows the
    // picture they sent. Documents don't carry a server-side artifact (the
    // client renders a local file chip during send).
    const inboundArtifacts: ToolArtifact[] = attachment?.imageArtifact
      ? [attachment.imageArtifact]
      : [];
    return NextResponse.json({
      inbound: {
        id: inbound.id,
        text: inbound.text,
        createdAt: inbound.createdAt.toISOString(),
        artifacts: inboundArtifacts,
      },
      outbound: {
        id: outbound.id,
        text: outbound.text,
        model: outbound.model,
        createdAt: outbound.createdAt.toISOString(),
      },
      reply,
      artifacts,
      ...(attachment?.note ? { warnings: [attachment.note] } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assistant/turn]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

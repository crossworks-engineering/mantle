/**
 * /api/assistant/turn — the web assistant's main inbound channel.
 *
 * Accepts EITHER:
 *   - application/json: { text }                          (text-only turn)
 *   - multipart/form-data: text + image|file (optional)   (attachment)
 *
 * An attachment is saved as a file node under
 * /files/assistant-uploads/<yyyy-mm-dd>/ (persistent + indexed by the
 * extractor), then `extractAttachmentForTurn` (shared with Telegram) turns it
 * into text for THIS turn — question-aware vision for images, parsed text for
 * documents (pdf/docx/xlsx/csv/txt/md/json/yaml). That text is folded into the
 * user message, with the file node id surfaced so Saskia can re-read the
 * original (extract_from_image / file_read) on a follow-up.
 *
 * The inline extraction is for the live reply only — durable, query-independent
 * metadata (data.text + summary + embedding + facts) is owned by the extractor,
 * which fires on the saved node. Extraction failures don't kill the turn; they
 * fall back to a "[… couldn't be read: <reason>]" marker.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { runAssistantTurn } from '@/lib/assistant';
import { extractAttachmentForTurn } from '@mantle/agent-runtime';
import {
  ensureDatedUploadFolder,
  extOf,
  mimeForExt,
  upsertFile,
  INGESTABLE_EXTS,
  MAX_UPLOAD_BYTES,
} from '@mantle/files';
import type { ToolArtifact } from '@mantle/tools';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({ text: z.string().min(1).max(20_000) });

const ASSISTANT_UPLOADS_SLUG = 'assistant-uploads';
const IMAGE_MIME_PREFIX = 'image/';

type Attachment = {
  kind: 'image' | 'file';
  nodeId: string | null;
  extractedText: string;
  note: string | null;
  imageArtifact: ToolArtifact | null;
};

/**
 * Save an uploaded attachment to /files/assistant-uploads/<date>/ and extract
 * its text for the current turn via the shared helper. The save fires
 * node_ingested → the extractor produces the durable index; this just gets the
 * responder enough to answer now. Save failures are non-fatal — extraction
 * still runs on the in-memory bytes.
 */
async function processUpload(
  ownerId: string,
  bytes: Buffer,
  mimeType: string,
  originalName: string,
  userText: string,
): Promise<Attachment> {
  let nodeId: string | null = null;
  try {
    const parentPath = await ensureDatedUploadFolder({
      ownerId,
      topSlug: ASSISTANT_UPLOADS_SLUG,
      topDescription: 'Files uploaded through the /assistant chat. Auto-created.',
    });
    // Preserve the real extension (pdf/docx/heic/…); fall back to the MIME
    // subtype when the upload had no name.
    const ext = extOf(originalName) || mimeType.split('/')[1] || 'bin';
    const safeBase = originalName
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w-]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '');
    const filename = `${Date.now()}-${safeBase || 'upload'}.${ext}`;
    const file = await upsertFile({ ownerId, parentPath, filename, bytes, overwrite: false });
    nodeId = file.id;
    void recordIngest({
      source: 'assistant_upload',
      ownerId,
      nodeId: file.id,
      summary: `Uploaded via /assistant: ${originalName}`,
      payload: { parentPath, filename, mimeType, sizeBytes: file.sizeBytes, originalName, via: 'web_assistant_chat' },
    });
  } catch (err) {
    console.warn('[assistant/turn] upload save failed:', err);
  }

  const extract = await extractAttachmentForTurn({
    ownerId,
    bytes,
    mimeType,
    filename: originalName,
    question: userText,
  });
  // 'unsupported' is pre-filtered by the caller, so this is image | file.
  const kind: 'image' | 'file' = extract.kind === 'file' ? 'file' : 'image';

  // Echo an image back as an inbound artifact so the user's bubble renders the
  // picture they sent. Documents render as a client-side file chip instead.
  const imageArtifact: ToolArtifact | null =
    kind === 'image'
      ? {
          kind: 'image',
          mimeType,
          base64: bytes.toString('base64'),
          caption: originalName,
          ...(nodeId ? { nodeId } : {}),
          producedBy: 'assistant-upload',
        }
      : null;

  return { kind, nodeId, extractedText: extract.text, note: extract.note, imageArtifact };
}

export async function POST(req: Request) {
  const user = await requireOwner();
  const contentType = req.headers.get('content-type') ?? '';

  let userText = '';
  let attachment: Attachment | null = null;

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
        'name' in file && typeof (file as File).name === 'string' ? (file as File).name : 'upload';
      const ext = extOf(originalName);
      const isImage = file.type.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(ext).startsWith('image/');
      const isDoc = INGESTABLE_EXTS.has(ext);
      if (!isImage && !isDoc) {
        return NextResponse.json(
          {
            error:
              `unsupported file type '${file.type || ext || 'unknown'}'. ` +
              'Supported: images, and documents (pdf, docx, xlsx, csv, txt, md, json, yaml).',
          },
          { status: 415 },
        );
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      attachment = await processUpload(user.id, bytes, file.type || mimeForExt(ext), originalName, userText);
    }
    if (!userText && !attachment) {
      return NextResponse.json({ error: 'either text or an attachment must be provided' }, { status: 400 });
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
              ? { base64: attachment.imageArtifact.base64, mimeType: attachment.imageArtifact.mimeType }
              : undefined,
            imageTranscript: attachment.extractedText || undefined,
            imageNote: attachment.note || undefined,
            imageNodeId: attachment.nodeId || undefined,
          }
        : undefined,
    );
    // Forward an inbound image artifact so the user's bubble shows the picture
    // they sent. Documents don't carry a server-side artifact (the client
    // renders a local file chip during send).
    const inboundArtifacts: ToolArtifact[] = attachment?.imageArtifact ? [attachment.imageArtifact] : [];
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

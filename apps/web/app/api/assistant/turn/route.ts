/**
 * /api/assistant/turn — the web assistant's main inbound channel.
 *
 * Accepts EITHER:
 *   - application/json: { text }                   (text-only turn)
 *   - multipart/form-data: text, image (optional)  (image attached)
 *
 * When an image rides along, we run the default vision worker
 * synchronously and prepend the extracted transcript to the user's
 * text. The LLM sees "Image attached, transcript: <...>" as part of
 * the user message — provider-agnostic (works regardless of the
 * assistant's chat model). The image itself is saved as a file node
 * under /files/uploads/<yyyy-mm-dd>/ so it's persistent + searchable.
 *
 * Vision worker failures don't kill the turn — we fall back to text-
 * only with a marker like "[Image attached but couldn't be read:
 * <error>]" so Saskia at least knows the user TRIED to share
 * something.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { runAssistantTurn } from '@/lib/assistant';
import { getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { getVisionAdapter } from '@mantle/voice';
import { createFolder, upsertFile } from '@mantle/files';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';
import { recordIngest } from '@mantle/tracing';

const Body = z.object({ text: z.string().min(1).max(20_000) });

const ASSISTANT_UPLOADS_SLUG = 'assistant-uploads';
const ASSISTANT_UPLOADS_LTREE = `files.${ASSISTANT_UPLOADS_SLUG}`;
const IMAGE_MIME_PREFIX = 'image/';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB — generous; Anthropic vision caps at 5 MB

async function ensureUploadFolder(ownerId: string): Promise<string> {
  // Top-level folder, then per-day subfolder. Same shape as
  // generate_image so the file tree stays consistent.
  for (const [parent, slug] of [
    ['files', ASSISTANT_UPLOADS_SLUG],
    [ASSISTANT_UPLOADS_LTREE, new Date().toISOString().slice(0, 10).replace(/-/g, '_')],
  ] as const) {
    const childPath = `${parent}.${slug}`;
    const [exists] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${childPath}`,
        ),
      )
      .limit(1);
    if (!exists) {
      try {
        await createFolder({
          ownerId,
          parentPath: parent,
          slug,
          description:
            parent === 'files'
              ? 'Files uploaded through the /assistant chat. Auto-created.'
              : `Uploads from ${slug.replace(/_/g, '-')}.`,
        });
      } catch (err) {
        if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  return `${ASSISTANT_UPLOADS_LTREE}.${today}`;
}

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
    const parentPath = await ensureUploadFolder(ownerId);
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
  const prompt =
    params.extraction_prompt?.trim() ||
    'Transcribe everything visible in this image verbatim, preserving line breaks and structure. If something is unclear, mark it [unclear]. Output plain text only.';
  try {
    const result = await adapter.extract(bytes, {
      apiKey,
      mimeType,
      prompt,
      systemPrompt: worker.systemPrompt ?? undefined,
      model: worker.model,
      maxTokens: params.max_tokens ?? 2000,
    });
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

export async function POST(req: Request) {
  const user = await requireOwner();
  const contentType = req.headers.get('content-type') ?? '';

  let userText = '';
  let imageContext: Awaited<ReturnType<typeof processUploadedImage>> | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
    }
    userText = ((form.get('text') as string | null) ?? '').trim();
    const file = form.get('image');
    if (file instanceof Blob && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `image too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
          { status: 413 },
        );
      }
      if (!file.type.startsWith(IMAGE_MIME_PREFIX)) {
        return NextResponse.json(
          { error: `unsupported file type '${file.type}' — only images supported here` },
          { status: 415 },
        );
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      // Form's File interface has a name; plain Blob doesn't.
      const originalName =
        'name' in file && typeof (file as File).name === 'string'
          ? (file as File).name
          : 'upload';
      imageContext = await processUploadedImage(user.id, bytes, file.type, originalName);
    }
    if (!userText && !imageContext) {
      return NextResponse.json(
        { error: 'either text or image must be provided' },
        { status: 400 },
      );
    }
    // If only an image was sent with no text, give the LLM a default
    // prompt so it has something to react to. Without this the user
    // experience is silent — Saskia would have nothing to respond to.
    if (!userText && imageContext) {
      userText = "Here's an image — tell me what you see.";
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

  // Compose the message the LLM actually sees. With an image attached
  // we sandwich the transcript between markers so the model knows
  // these are vision-extracted lines (not the user's own typed text).
  const messageForLlm =
    imageContext && imageContext.extractedText
      ? `${userText}\n\n[Attached image — vision worker transcript:]\n${imageContext.extractedText}`
      : imageContext && imageContext.note
      ? `${userText}\n\n[Image attached but couldn't be read: ${imageContext.note}]`
      : userText;

  try {
    const { inbound, outbound, reply, artifacts } = await runAssistantTurn(
      user.id,
      messageForLlm,
      // Keep the persisted inbound row + the chat bubble showing the
      // user's actual typed text, not the LLM-augmented version that
      // includes the vision transcript. The user sees what they typed;
      // the LLM sees the transcript appended; the image lives in
      // /files for later retrieval.
      imageContext ? { displayText: userText } : undefined,
    );
    // Forward the inbound image as an inbound-side artifact so the
    // user's bubble shows the picture they sent (alongside their
    // text). Combined with tool-emitted artifacts on the outbound
    // side, the chat renders the full media exchange in-place.
    const inboundArtifacts: ToolArtifact[] = imageContext?.imageArtifact
      ? [imageContext.imageArtifact]
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
      ...(imageContext?.note
        ? { warnings: [imageContext.note] }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assistant/turn]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

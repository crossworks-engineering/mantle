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
import { getOwnerOr401WithSource } from '@/lib/auth';
import { getDbosClient } from '@/lib/dbos-client';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';
import {
  ASSISTANT_TURN_WORKFLOW,
  RUNNER_QUEUE,
  type AssistantTurnInput,
  type AssistantTurnRunResult,
  type RunAssistantTurnOptions,
} from '@mantle/assistant-runtime';
import {
  sanitizeLocationPing,
  loadProfilePreferences,
  isStreamThoughtsEnabled,
  type LocationPing,
} from '@mantle/content';
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
import { recordIngest, startTrace, step } from '@mantle/tracing';

const Body = z.object({
  text: z.string().min(1).max(20_000),
  agentSlug: z.string().optional(),
  // Device location the companion app attaches to each message. Validated by
  // sanitizeLocationPing (tolerant: bad fields drop, never fatal), not zod —
  // accept anything object-shaped here and let the sanitizer decide.
  location: z.unknown().optional(),
});

/** Parse a multipart `location` form field (a JSON string) into a clean ping. */
function locationFromForm(raw: FormDataEntryValue | null): LocationPing | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return sanitizeLocationPing(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

const ASSISTANT_UPLOADS_SLUG = 'assistant-uploads';
const IMAGE_MIME_PREFIX = 'image/';

type Attachment = {
  kind: 'image' | 'file';
  nodeId: string | null;
  extractedText: string;
  note: string | null;
  imageArtifact: ToolArtifact | null;
  /** Original filename — lets the responder marker route a spreadsheet to Tables. */
  filename: string;
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
  const isImage = mimeType.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(extOf(originalName)).startsWith('image/');
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

  // Trace the inline (live-answer) extraction so its cost + failures are
  // visible — parity with the Telegram path. The durable index is a separate
  // extractor_run/photo_ingest off the saved node.
  const extract = await startTrace(
    {
      kind: isImage ? 'photo_ingest' : 'content_ingest',
      ownerId,
      subjectId: nodeId ?? undefined,
      subjectKind: 'node',
      data: { source: 'assistant', filename: originalName, hasQuestion: userText.trim().length > 0 },
    },
    async () =>
      step(
        { name: 'extract_attachment', kind: 'llm_call', input: { mime: mimeType, bytes: bytes.length } },
        async (h) => {
          const r = await extractAttachmentForTurn({
            ownerId,
            bytes,
            mimeType,
            filename: originalName,
            question: userText,
          });
          h.setMeta({ attachmentKind: r.kind, note: r.note, textLength: r.text.length });
          return r;
        },
      ),
  );
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

  return { kind, nodeId, extractedText: extract.text, note: extract.note, imageArtifact, filename: originalName };
}

type TurnResult = { status: number; body: unknown };

// In-memory idempotency. A duplicate request with the same Idempotency-Key
// (a network retry, or the same submit sent twice) replays the first turn's
// result instead of saving the file + running the LLM again. Single-process
// scope (one web instance, single user); lost on restart, which is fine —
// duplicates only matter within seconds.
const TURN_DEDUP_TTL_MS = 2 * 60_000;
const recentTurns = new Map<string, { at: number; result: TurnResult }>();
const inflightTurns = new Map<string, Promise<TurnResult>>();

function pruneRecentTurns() {
  const now = Date.now();
  for (const [k, v] of recentTurns) {
    if (now - v.at > TURN_DEDUP_TTL_MS) recentTurns.delete(k);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const toResponse = (r: TurnResult) => NextResponse.json(r.body, { status: r.status });
  const key = req.headers.get('idempotency-key');
  if (!key) return toResponse(await runTurn(req, null));

  const cached = recentTurns.get(key);
  if (cached && Date.now() - cached.at < TURN_DEDUP_TTL_MS) return toResponse(cached.result);

  let pending = inflightTurns.get(key);
  if (!pending) {
    pending = runTurn(req, key);
    inflightTurns.set(key, pending);
    pending
      .then((result) => {
        recentTurns.set(key, { at: Date.now(), result });
        pruneRecentTurns();
      })
      .finally(() => inflightTurns.delete(key));
  }
  return toResponse(await pending);
}

async function runTurn(req: Request, idempotencyKey: string | null): Promise<TurnResult> {
  // Auth before the try so a failure surfaces as a clean 401 (not a swallowed
  // 500, and not an HTML login redirect — a programmatic client needs a status).
  // The route is also gated by middleware. `source` tags the turn 'web'
  // (browser) vs 'mobile' (companion).
  const auth = await getOwnerOr401WithSource();
  if (auth instanceof NextResponse) return { status: 401, body: { error: 'unauthorized' } };
  const { user, source } = auth;
  const contentType = req.headers.get('content-type') ?? '';

  let userText = '';
  let agentSlug: string | undefined;
  let attachment: Attachment | null = null;
  let location: LocationPing | undefined;

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData().catch(() => null);
      if (!form) return { status: 400, body: { error: 'invalid multipart body' } };
      userText = ((form.get('text') as string | null) ?? '').trim();
      agentSlug = ((form.get('agentSlug') as string | null) ?? '').trim() || undefined;
      location = locationFromForm(form.get('location'));
      // Images arrive under 'image', documents under 'file'; accept either.
      const file = form.get('image') ?? form.get('file');
      if (file instanceof Blob && file.size > 0) {
        if (file.size > MAX_UPLOAD_BYTES) {
          return {
            status: 413,
            body: { error: `attachment too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
          };
        }
        // Form's File interface has a name; plain Blob doesn't.
        const originalName =
          'name' in file && typeof (file as File).name === 'string' ? (file as File).name : 'upload';
        const ext = extOf(originalName);
        const isImage = file.type.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(ext).startsWith('image/');
        const isDoc = INGESTABLE_EXTS.has(ext);
        if (!isImage && !isDoc) {
          return {
            status: 415,
            body: {
              error:
                `unsupported file type '${file.type || ext || 'unknown'}'. ` +
                'Supported: images, and documents (pdf, docx, xlsx, csv, txt, md, json, yaml).',
            },
          };
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        attachment = await processUpload(user.id, bytes, file.type || mimeForExt(ext), originalName, userText);
      }
      if (!userText && !attachment) {
        return { status: 400, body: { error: 'either text or an attachment must be provided' } };
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
        return { status: 400, body: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
      }
      userText = parsed.data.text;
      agentSlug = parsed.data.agentSlug?.trim() || undefined;
      location = sanitizeLocationPing(parsed.data.location) ?? undefined;
    }

    // Hand the turn the attachment's extracted text (+ the raw image for a
    // vision-capable responder). The runtime is transcript-default: it folds
    // the text in and only inlines raw pixels when there's no transcript.
    // The persisted inbound row shows the user's own typed text (displayText).
    // Live streaming is on when the deploy allows it (env, default-on) AND this
    // brain hasn't turned it off in Settings → Profile. When off we omit the
    // streamId (so the producer never publishes for this turn) and fall through
    // to the blocking path below — the chat shows a static thinking bubble.
    const streamingOn =
      isTurnStreamingEnabled() && isStreamThoughtsEnabled(await loadProfilePreferences(user.id));

    const options: RunAssistantTurnOptions = {
      agentSlug,
      channel: source,
      // The client mints one uuid per submit and sends it as the Idempotency-Key
      // (it's also the workflow id). Reuse it as the live-stream correlation id
      // so the producer publishes this turn's status on the same id the client
      // already subscribed to — no extra wire field.
      ...(streamingOn && idempotencyKey ? { streamId: idempotencyKey } : {}),
      ...(location ? { location } : {}),
      ...(attachment
        ? {
            displayText: userText,
            attachmentKind: attachment.kind,
            image: attachment.imageArtifact
              ? { base64: attachment.imageArtifact.base64, mimeType: attachment.imageArtifact.mimeType }
              : undefined,
            imageTranscript: attachment.extractedText || undefined,
            imageNote: attachment.note || undefined,
            imageNodeId: attachment.nodeId || undefined,
            imageFilename: attachment.filename || undefined,
          }
        : {}),
    };
    const input: AssistantTurnInput = { ownerId: user.id, text: userText, options };

    // Run the turn on the dedicated apps/api runner: enqueue the durable
    // workflow, then await its result. The work EXECUTES in apps/api (off this
    // request, journaled by DBOS), so it survives a web-process restart and a
    // client disconnect — if this await is abandoned (the user navigates away),
    // the workflow still completes and persists, and the client reconciles via
    // syncLatest on return. The idempotency-key (when present) is the workflow
    // id, so a retried submit replays the same run instead of starting a new one.
    const client = await getDbosClient();
    const handle = await client.enqueue<(i: AssistantTurnInput) => Promise<AssistantTurnRunResult>>(
      {
        workflowName: ASSISTANT_TURN_WORKFLOW,
        queueName: RUNNER_QUEUE,
        ...(idempotencyKey ? { workflowID: idempotencyKey } : {}),
      },
      input,
    );

    // Non-blocking delivery. When live streaming is on AND the client minted a
    // turn id (the idempotency-key — both the workflow id and the live-stream
    // correlation id), return 202 immediately with just that id. The turn keeps
    // running in apps/api; the client types the reply out off the live stream and
    // reconciles to the durable row on `done`/`error`. This frees the request
    // from holding a minutes-long connection and lets a turn truly survive
    // navigation/backgrounding. The durable outbound row (inserted 'pending' by
    // the runner) is the source of truth. See docs/live-turn-streaming.md §6-§7.
    if (streamingOn && idempotencyKey) {
      return {
        status: 202,
        body: {
          turnId: idempotencyKey,
          ...(attachment?.note ? { warnings: [attachment.note] } : {}),
        },
      };
    }

    // Legacy blocking path (streaming off, or no idempotency-key): await the
    // result and relay the same response shape the in-process turn returned.
    const { inbound, outbound, reply, artifacts } = await handle.getResult();
    // Forward inbound image METADATA (no base64) — the client already holds
    // the bytes and renders them from a local object URL, so echoing the full
    // base64 back would just waste bandwidth. Documents carry no artifact.
    const inboundArtifacts: ToolArtifact[] = attachment?.imageArtifact
      ? [{ ...attachment.imageArtifact, base64: '' }]
      : [];
    return {
      status: 200,
      body: {
        inbound: {
          id: inbound.id,
          text: inbound.text,
          createdAt: inbound.createdAt,
          artifacts: inboundArtifacts,
        },
        outbound: {
          id: outbound.id,
          text: outbound.text,
          model: outbound.model,
          createdAt: outbound.createdAt,
        },
        reply,
        artifacts,
        ...(attachment?.note ? { warnings: [attachment.note] } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assistant/turn]', msg);
    return { status: 500, body: { error: msg } };
  }
}

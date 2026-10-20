/**
 * /api/assistant/turn — the web assistant's main inbound channel.
 *
 * Accepts EITHER:
 *   - application/json: { text }                          (text-only turn)
 *   - multipart/form-data: text + image|file (optional)   (attachment)
 *
 * An attachment is saved as a file node under
 * /files/auto-filed/assistant-uploads/<yyyy-mm>/ (persistent + indexed by the
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
 *
 * Any login (workspaces W7c): every user chats with the assistant of each
 * workspace it is a user of, in its own thread (lib/assistant-chat.ts). The
 * Admin assistant and the owner's helpers run on the owner turn engine (an
 * Admin user only, as before); an assistant of another workspace runs on the
 * workspace turn engine (lib/workspace-turn.ts: no Journal, no "About the
 * user", the member limits for a login that is not an Admin user), text
 * only, answering 202 `{ turnId }`.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { chatCaller, type ChatCaller } from '@/lib/auth';
import { chatAdmin, resolveChatAgentToWrite, type ChatAgent } from '@/lib/assistant-chat';
import { queueWorkspaceTurn } from '@/lib/workspace-turn';
import { getDbosClient } from '@/lib/dbos-client';
import { ASSISTANT_TURN_MAX_CHARS } from '@mantle/client-types/assistant-limits';
import { feature } from '@mantle/config';
import {
  ASSISTANT_TURN_WORKFLOW,
  RUNNER_QUEUE,
  type AssistantTurnInput,
  type AssistantTurnRunResult,
  type RunAssistantTurnOptions,
} from '@mantle/runtime/assistant';
import { sanitizeLocationPing, loadProfilePreferences, type LocationPing } from '@mantle/content';
import { extractAttachmentForTurn } from '@mantle/runtime/agent';
import {
  ensureAutoFiledFolder,
  extOf,
  mimeForExt,
  upsertFile,
  INGESTABLE_EXTS,
  MAX_UPLOAD_BYTES,
} from '@mantle/files';
import type { ToolArtifact } from '@mantle/tools';
import { log, recordIngest, startTrace, step } from '@mantle/tracing';
import { errorMessage, TtlCache } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readJson } from '@/lib/read-body';

const logger = log('assistant/turn');

/** Human-readable over-limit error — zod's default ("Too big: expected string
 *  to have <=20000 characters") reaches real users through clients without the
 *  composer's note-offload (the companion app, the dock), so say it plainly. */
function tooLongError(length: number): string {
  return (
    `message too long: ${length.toLocaleString('en-US')} characters, the limit per turn is ` +
    `${ASSISTANT_TURN_MAX_CHARS.toLocaleString('en-US')}. Send the overflow as an attachment ` +
    'or split the message.'
  );
}

const Body = z.object({
  text: z
    .string()
    .min(1)
    .max(ASSISTANT_TURN_MAX_CHARS, { error: (iss) => tooLongError(String(iss.input).length) }),
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
 * Save an uploaded attachment to /files/auto-filed/assistant-uploads/<month>/ and extract
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
  const isImage =
    mimeType.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(extOf(originalName)).startsWith('image/');
  let nodeId: string | null = null;
  try {
    const parentPath = await ensureAutoFiledFolder(ownerId, 'assistant-uploads');
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
    logger.warn('upload save failed:', err);
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
      data: {
        source: 'assistant',
        filename: originalName,
        hasQuestion: userText.trim().length > 0,
      },
    },
    async () =>
      step(
        {
          name: 'extract_attachment',
          kind: 'llm_call',
          input: { mime: mimeType, bytes: bytes.length },
        },
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

  return {
    kind,
    nodeId,
    extractedText: extract.text,
    note: extract.note,
    imageArtifact,
    filename: originalName,
  };
}

type TurnResult = { status: number; body: unknown; headers?: HeadersInit };

// In-memory idempotency. A duplicate request with the same Idempotency-Key
// (a network retry, or the same submit sent twice) replays the first turn's
// result instead of saving the file and running the LLM again. Single-process
// scope (one web instance); lost on restart, which is fine: duplicates only
// matter within seconds. Keyed by the signed-in login AND the key, and read
// only after the request is authenticated (W7c fix round 1, L1): one login's
// key never replays another login's turn, nor answers an unauthenticated
// request.
const TURN_DEDUP_TTL_MS = 2 * 60_000;
const recentTurns = new TtlCache<string, TurnResult>({ ttlMs: TURN_DEDUP_TTL_MS });
const inflightTurns = new Map<string, Promise<TurnResult>>();

export async function POST(req: Request): Promise<NextResponse> {
  // The login the gate answered, before the dedup cache is read, so a
  // failure surfaces as a clean 401 (not a swallowed 500, and not an HTML
  // login redirect: a programmatic client needs a status). `source` tags
  // the turn 'web' (browser) vs 'mobile' (companion).
  const login = chatCaller();
  const toResponse = (r: TurnResult) =>
    NextResponse.json(r.body, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });
  const key = req.headers.get('idempotency-key');
  if (!key) return toResponse(await runTurn(req, login, null));

  const cacheKey = `${login.loginId}:${key}`;
  const cached = recentTurns.get(cacheKey);
  if (cached) return toResponse(cached);

  let pending = inflightTurns.get(cacheKey);
  if (!pending) {
    pending = runTurn(req, login, key);
    inflightTurns.set(cacheKey, pending);
    pending
      .then((result) => {
        recentTurns.set(cacheKey, result);
        recentTurns.prune();
      })
      .finally(() => inflightTurns.delete(cacheKey));
  }
  return toResponse(await pending);
}

/** The owner engine's workflow id for a turn with an Idempotency-Key: the
 *  login is part of it (W7c fix round 1, L1), so another login reusing the
 *  key starts its own turn and never lands on this one. */
function ownerTurnWorkflowId(loginId: string, key: string): string {
  return `turn-${loginId}.${key}`;
}

async function runTurn(
  req: Request,
  login: ChatCaller,
  idempotencyKey: string | null,
): Promise<TurnResult> {
  const { user, source } = login;
  // Whether the login is an Admin user (adminFacts, asked of its scope),
  // asked once here, before the turn enters any scope of its own.
  const admin = await chatAdmin(login);
  const contentType = req.headers.get('content-type') ?? '';

  let userText: string;
  let agentSlug: string | undefined;
  let attachment: Attachment | null = null;
  let location: LocationPing | undefined;
  let chatAgent: ChatAgent | null;
  const noAgent: TurnResult = {
    status: 404,
    body: { error: 'no assistant to chat with here', reason: 'no-chat-agent' },
  };
  const multipart = contentType.includes('multipart/form-data');
  // The JSON body: this upload path has no loader ceiling (its multipart
  // attachment has its own cap), so the read takes the JSON one (A10 part
  // 2). Read before the try below, whose catch answers the turn's errors.
  const raw = multipart ? null : await readJson(req, { maxBytes: JSON_BODY_CEILING_BYTES });

  try {
    if (multipart) {
      const form = await req.formData().catch(() => null);
      if (!form) return { status: 400, body: { error: 'invalid multipart body' } };
      userText = ((form.get('text') as string | null) ?? '').trim();
      // Same ceiling as the JSON branch — an uncapped multipart path meant the
      // limit was two different numbers depending on whether a file rode along.
      if (userText.length > ASSISTANT_TURN_MAX_CHARS) {
        return { status: 400, body: { error: tooLongError(userText.length) } };
      }
      agentSlug = ((form.get('agentSlug') as string | null) ?? '').trim() || undefined;
      location = locationFromForm(form.get('location'));
      chatAgent = await resolveChatAgentToWrite(login, agentSlug);
      if (!chatAgent) return noAgent;
      // Images arrive under 'image', documents under 'file'; accept either.
      const file = form.get('image') ?? form.get('file');
      if (file instanceof Blob && file.size > 0 && chatAgent.turnEngine === 'workspace') {
        // An upload is saved as a brain item; a workspace chat takes text.
        return {
          status: 415,
          body: { error: 'attachments are not supported in this chat yet: send text' },
        };
      }
      if (file instanceof Blob && file.size > 0) {
        if (file.size > MAX_UPLOAD_BYTES) {
          return {
            status: 413,
            body: { error: `attachment too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
          };
        }
        // Form's File interface has a name; plain Blob doesn't.
        const originalName =
          'name' in file && typeof (file as File).name === 'string'
            ? (file as File).name
            : 'upload';
        const ext = extOf(originalName);
        const isImage =
          file.type.startsWith(IMAGE_MIME_PREFIX) || mimeForExt(ext).startsWith('image/');
        const isDoc = INGESTABLE_EXTS.has(ext);
        if (!isImage && !isDoc) {
          return {
            status: 415,
            body: {
              error:
                `unsupported file type '${file.type || ext || 'unknown'}'. ` +
                'Supported: images, and documents (pdf, docx, xlsx, csv, txt, md, json, yaml, dwf, dwg, dxf).',
            },
          };
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        attachment = await processUpload(
          user.id,
          bytes,
          file.type || mimeForExt(ext),
          originalName,
          userText,
        );
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
      const parsed = Body.safeParse(raw);
      if (!parsed.success) {
        return { status: 400, body: { error: firstIssue(parsed.error) } };
      }
      userText = parsed.data.text;
      agentSlug = parsed.data.agentSlug?.trim() || undefined;
      location = sanitizeLocationPing(parsed.data.location) ?? undefined;
      chatAgent = await resolveChatAgentToWrite(login, agentSlug);
      if (!chatAgent) return noAgent;
    }

    // An assistant of a workspace other than Admin: the workspace engine.
    if (chatAgent.turnEngine === 'workspace') {
      const streamable =
        admin &&
        !!idempotencyKey &&
        feature('turnStreaming') &&
        feature('streamThoughts', { prefs: await loadProfilePreferences(login.ownerId) });
      return queueWorkspaceTurn({
        login,
        agent: chatAgent,
        text: userText.trim(),
        idempotencyKey,
        ...(streamable && idempotencyKey ? { streamId: idempotencyKey } : {}),
      });
    }
    // The owner engine: an Admin user only (resolveChatAgent never hands a
    // member or a client an owner agent; this is the route's own check).
    if (!admin) return noAgent;

    // Hand the turn the attachment's extracted text (+ the raw image for a
    // vision-capable responder). The runtime is transcript-default: it folds
    // the text in and only inlines raw pixels when there's no transcript.
    // The persisted inbound row shows the user's own typed text (displayText).
    // Live streaming is on when the deploy allows it (env, default-on) AND this
    // brain hasn't turned it off in Settings → Profile. When off we omit the
    // streamId (so the producer never publishes for this turn) and fall through
    // to the blocking path below — the chat shows a static thinking bubble.
    const streamingOn =
      feature('turnStreaming') &&
      feature('streamThoughts', { prefs: await loadProfilePreferences(user.id) });

    // The agent resolveChatAgent picked: an explicit slug, else THIS LOGIN's
    // assigned assistant (migration 0143), else the brain-wide default. Each
    // login has its own thread with it either way (0269).
    agentSlug = chatAgent.slug;

    const options: RunAssistantTurnOptions = {
      agentSlug,
      // The signed-in login (R3): its messages and trace carry it.
      loginId: user.actor.id,
      // An API key ('api') never reaches this route (keys work on /api/v1
      // only); the type still names it, so it maps to no channel.
      channel: source === 'api' ? undefined : source,
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
              ? {
                  base64: attachment.imageArtifact.base64,
                  mimeType: attachment.imageArtifact.mimeType,
                }
              : undefined,
            imageTranscript: attachment.extractedText || undefined,
            imageNote: attachment.note || undefined,
            imageNodeId: attachment.nodeId || undefined,
            imageFilename: attachment.filename || undefined,
          }
        : {}),
    };
    const input: AssistantTurnInput = { ownerId: user.id, text: userText, options };

    // Run the turn on the dedicated server/api runner: enqueue the durable
    // workflow, then await its result. The work EXECUTES in server/api (off this
    // request, journaled by DBOS), so it survives a web-process restart and a
    // client disconnect — if this await is abandoned (the user navigates away),
    // the workflow still completes and persists, and the client reconciles via
    // syncLatest on return. The idempotency-key (when present), with the login,
    // is the workflow id, so a retried submit replays the same run instead of
    // starting a new one.
    const client = await getDbosClient();
    const handle = await client.enqueue<(i: AssistantTurnInput) => Promise<AssistantTurnRunResult>>(
      {
        workflowName: ASSISTANT_TURN_WORKFLOW,
        queueName: RUNNER_QUEUE,
        ...(idempotencyKey
          ? { workflowID: ownerTurnWorkflowId(user.actor.id, idempotencyKey) }
          : {}),
      },
      input,
    );

    // Non-blocking delivery. When live streaming is on AND the client minted a
    // turn id (the idempotency-key — both the workflow id and the live-stream
    // correlation id), return 202 immediately with just that id. The turn keeps
    // running in server/api; the client types the reply out off the live stream and
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
    const msg = errorMessage(err);
    logger.error(msg);
    // The failed turn's text is mostly the provider's answer: an Admin user
    // reads it (it set the provider up), a member or a client gets a fixed
    // sentence and the detail stays in the log (fix round 1, L6).
    return { status: 500, body: { error: admin ? msg : TURN_FAILED_MESSAGE } };
  }
}

/** What a member or a client hears when a turn fails (the detail is in the
 *  server log). */
const TURN_FAILED_MESSAGE = 'The assistant could not answer. Try again.';

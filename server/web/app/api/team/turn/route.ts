/**
 * POST /api/team/turn — a team member's inbound channel.
 *
 * The /team analogue of /api/assistant/turn, minus the owner-personal extras:
 * accepts JSON `{ text }` or multipart (text + file), authenticates via the
 * team-chat cookie OR a bearer team token (the MS Teams adapter seam), and
 * enqueues the durable TEAM_TURN_WORKFLOW on the shared runner queue.
 *
 * Cost guards (a leaked 8-char token must never become a wallet drain):
 *   - per-contact rate limit (turns/minute), and
 *   - a per-contact DAILY turn cap (env TEAM_CHAT_DAILY_TURNS, default 100).
 * Both denials land in the team access log as kind 'denied'.
 *
 * Attachments are saved under /files/team-uploads/<date>/ with provenance
 * `data.source = 'team:<contactId>'` — they enter the brain corpus by design
 * ("please update X with this file"), and provenance keeps team-contributed
 * content distinguishable forever.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDbosClient } from '@/lib/dbos-client';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller, teamCallerName, mintTeamTurnId } from '@/lib/team-chat-gate';
import { forumDailySpend, FORUM_DAILY_CAP } from '@/lib/forum-gate';
import {
  TEAM_TURN_WORKFLOW,
  RUNNER_QUEUE,
  type TeamTurnInput,
  type TeamTurnRunResult,
  type RunTeamTurnOptions,
} from '@mantle/assistant-runtime';
import { recordTeamAccess } from '@mantle/content';
import {
  ensureDatedUploadFolder,
  extOf,
  mimeForExt,
  upsertFile,
  INGESTABLE_EXTS,
  MAX_UPLOAD_BYTES,
} from '@mantle/files';
import { db, nodes, type ConversationAttachment } from '@mantle/db';
import { and, eq, sql } from 'drizzle-orm';
import { recordIngest } from '@mantle/tracing';

export const runtime = 'nodejs';

const Body = z.object({ text: z.string().min(1).max(20_000) });

const TEAM_UPLOADS_SLUG = 'team-uploads';

// The 1:1 Team Chat became a READ-ONLY archive when the Team Forum shipped: the
// member composer is gone and the conversation moved to /team/forum. This write
// path is therefore CLOSED by default — closing it (a) makes the archive claim
// true rather than UI-only (a curl/bearer member could otherwise keep chatting)
// and (b) leaves the forum as the SINGLE spend path, so the shared daily cap
// can't be exceeded by splitting turns across two surfaces. Set
// TEAM_CHAT_POST_ENABLED=1 to reopen (e.g. to reactivate the MS Teams seam).
const TEAM_CHAT_POST_ENABLED = process.env.TEAM_CHAT_POST_ENABLED === '1';

export async function POST(req: Request): Promise<NextResponse> {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { ownerId, contactId, channel } = caller;

  if (!TEAM_CHAT_POST_ENABLED) {
    recordTeamAccess({ ownerId, contactId, kind: 'denied', detail: { reason: 'chat_archived' } });
    return NextResponse.json(
      { error: 'Team Chat has moved to the Forum — start or reply to a topic there instead.' },
      { status: 410 },
    );
  }

  // Per-contact turn rate (burst) + daily cap (budget). Rate first — it's free.
  const gate = rateLimit(`team-turn:${contactId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    recordTeamAccess({ ownerId, contactId, kind: 'denied', detail: { reason: 'rate_limit' } });
    return NextResponse.json(
      { error: 'too many messages — give me a moment' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  // ONE shared daily budget across chat + forum (forumDailySpend sums both), so
  // reopening this path can never double a member's cap.
  const usedToday = await forumDailySpend(ownerId, contactId);
  if (usedToday >= FORUM_DAILY_CAP) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'daily_cap', cap: FORUM_DAILY_CAP },
    });
    return NextResponse.json(
      { error: `daily message limit reached (${FORUM_DAILY_CAP}/day) — try again tomorrow` },
      { status: 429 },
    );
  }

  const contentType = req.headers.get('content-type') ?? '';
  let userText: string;
  let llmText = '';
  const attachments: ConversationAttachment[] = [];

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData().catch(() => null);
      if (!form) return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
      // Clamp to the same bound as the JSON path — the multipart branch would
      // otherwise accept an unbounded `text` field, defeating the per-turn cost
      // assumption behind the rate + daily caps.
      userText = ((form.get('text') as string | null) ?? '').trim().slice(0, 20_000);
      const file = form.get('file') ?? form.get('image');
      if (file instanceof Blob && file.size > 0) {
        if (file.size > MAX_UPLOAD_BYTES) {
          return NextResponse.json(
            { error: `attachment too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
            { status: 413 },
          );
        }
        const originalName =
          'name' in file && typeof (file as File).name === 'string'
            ? (file as File).name
            : 'upload';
        const ext = extOf(originalName);
        const isImage = file.type.startsWith('image/') || mimeForExt(ext).startsWith('image/');
        if (!isImage && !INGESTABLE_EXTS.has(ext)) {
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
        const parentPath = await ensureDatedUploadFolder({
          ownerId,
          topSlug: TEAM_UPLOADS_SLUG,
          topDescription: 'Files uploaded by team members through Team Chat. Auto-created.',
        });
        const safeBase = originalName
          .toLowerCase()
          .replace(/\.[^.]+$/, '')
          .replace(/[^\w-]+/g, '-')
          .slice(0, 60)
          .replace(/^-+|-+$/g, '');
        const filename = `${Date.now()}-${safeBase || 'upload'}.${ext || file.type.split('/')[1] || 'bin'}`;
        const saved = await upsertFile({
          ownerId,
          parentPath,
          filename,
          bytes,
          overwrite: false,
        });
        // Provenance: team-contributed content must be distinguishable forever.
        await db
          .update(nodes)
          .set({
            data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({ source: `team:${contactId}` })}::jsonb`,
          })
          .where(and(eq(nodes.id, saved.id), eq(nodes.ownerId, ownerId)))
          .catch(() => {});
        void recordIngest({
          source: 'team_upload',
          ownerId,
          nodeId: saved.id,
          summary: `Uploaded via Team Chat: ${originalName}`,
          payload: { parentPath, filename, contactId, originalName, sizeBytes: saved.sizeBytes },
        });
        attachments.push({
          kind: isImage ? 'image' : 'document',
          mime: file.type || mimeForExt(ext),
          nodeId: saved.id,
        });
        // Fold a marker into the LLM text so the responder knows the file is
        // there and can read it (file_read / search after the extractor runs).
        llmText =
          `${userText || 'I have attached a file.'}\n\n` +
          `[The member attached "${originalName}" — saved as file node ${saved.id}. ` +
          `Read it with file_read if the request depends on its contents.]`;
      }
      if (!userText && attachments.length === 0) {
        return NextResponse.json(
          { error: 'either text or an attachment must be provided' },
          { status: 400 },
        );
      }
      if (!userText) userText = 'I have attached a file — please take a look.';
    } else {
      const parsed = Body.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? 'invalid input' },
          { status: 400 },
        );
      }
      userText = parsed.data.text;
    }

    // Turn id is minted SERVER-SIDE with the contact baked in, so it can only
    // ever address THIS member's turn — this is the cross-member isolation
    // boundary for both the DBOS workflowID (a client-chosen id could otherwise
    // dedup onto another member's workflow and return their result) and the SSE
    // stream (which the stream route re-checks against the embedded contact). A
    // client-supplied Idempotency-Key is used only as the NONCE half, preserving
    // retry dedup without letting the client control the contact half.
    const idempotencyKey = req.headers.get('idempotency-key') ?? undefined;
    const turnId = mintTeamTurnId(contactId, idempotencyKey);
    const streamingOn = isTurnStreamingEnabled();
    const streamId = streamingOn ? turnId : undefined;

    const contactName = await teamCallerName(ownerId, contactId);
    const options: RunTeamTurnOptions = {
      contactId,
      contactName,
      channel,
      ...(streamId ? { streamId } : {}),
      ...(attachments.length ? { displayText: userText, attachments } : {}),
    };
    const input: TeamTurnInput = { ownerId, text: llmText || userText, options };

    recordTeamAccess({
      ownerId,
      contactId,
      kind: channel === 'api' ? 'api' : 'turn',
      detail: { chars: userText.length, attachments: attachments.length },
    });

    const client = await getDbosClient();
    const handle = await client.enqueue<(i: TeamTurnInput) => Promise<TeamTurnRunResult>>(
      {
        workflowName: TEAM_TURN_WORKFLOW,
        queueName: RUNNER_QUEUE,
        workflowID: turnId,
      },
      input,
    );

    if (streamId) return NextResponse.json({ turnId: streamId }, { status: 202 });

    const { inbound, outbound, reply } = await handle.getResult();
    return NextResponse.json({
      inbound: { id: inbound.id, text: inbound.text, createdAt: inbound.createdAt },
      outbound: { id: outbound.id, text: outbound.text, createdAt: outbound.createdAt },
      reply,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[team/turn]', msg);
    // Uniform message — internals (agent config, provider errors) stay
    // owner-side; the member sees a clean failure, the admin sees traces.
    return NextResponse.json(
      { error: 'something went wrong handling that message — the brain admin can see the details' },
      { status: 500 },
    );
  }
}

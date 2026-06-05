/**
 * Phase 6 (docs/conversation.md): one-time backfill of existing Telegram history
 * into the unified per-(owner, agent) conversation stream, + re-key existing
 * conversation-digest notes with data.agent_id.
 *
 * Why: after the Phase 3 cutover the responder reads history (and the
 * summarizer rolls up) from assistant_messages, but pre-cutover Telegram turns
 * live only in telegram_messages, and pre-cutover digests carry data.chat_id /
 * source='web' rather than data.agent_id. So a Telegram thread's short-term
 * history + its older digests look empty until this runs.
 *
 * What it does:
 *   1. Copies each telegram_messages row → an assistant_messages row
 *      (channel='telegram'), preserving sent_at as created_at so the unified
 *      stream stays chronological. Carries over digest_node_id so already-
 *      digested turns are NOT re-summarized.
 *   2. Re-keys conversation-digest notes lacking data.agent_id:
 *        - telegram digests (data.chat_id) → the chat's resolved responder
 *        - web digests        → the majority agent of the turns they cover
 *
 * Safety:
 *   - DRY-RUN by default; pass --apply to write.
 *   - IDEMPOTENT: skips telegram rows already represented in assistant_messages
 *     (by external_ref.telegramRowId, or external_ref.messageId for the
 *     post-cutover rows handleMessage already created).
 *   - Disables the summarize_due trigger for the insert burst so the backfill
 *     doesn't kick off summarization mid-run, then re-enables it (finally). The
 *     digest re-key is a nodes UPDATE — node_ingested is INSERT-only, so it does
 *     not re-fire extraction.
 *
 * Run:
 *   pnpm -C apps/web backfill:conversation           # dry-run report
 *   pnpm -C apps/web backfill:conversation --apply    # write
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  channels,
  nodes,
  telegramMessages,
  telegramChats,
  telegramAccounts,
  type ConversationAttachment,
  type ConversationExternalRef,
  type TelegramAttachment,
} from '@mantle/db';

const OWNER_ID = process.env.ALLOWED_USER_ID;
const SUMMARIZE_TRIGGER = 'assistant_messages_summarize_due_trg';

type AgentRef = { id: string; slug: string };

/** Mirror of resolveResponderAgent (apps/agent/src/main.ts): per-chat override
 *  → the channel's agent → global highest-priority enabled conversational
 *  agent (role-decoupled, docs/comms-channels.md). */
async function resolveChatAgent(
  ownerId: string,
  overrideAgentId: string | null,
  channelAgentId: string | null,
): Promise<AgentRef | null> {
  for (const pinnedId of [overrideAgentId, channelAgentId]) {
    if (!pinnedId) continue;
    const [pinned] = await db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(and(eq(agents.id, pinnedId), eq(agents.ownerId, ownerId), eq(agents.enabled, true)))
      .limit(1);
    if (pinned) return pinned;
  }
  const [row] = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, ['assistant', 'responder', 'custom']),
      ),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
}

const TG_KIND: Record<string, ConversationAttachment['kind'] | undefined> = {
  photo: 'image',
  document: 'document',
  voice: 'voice',
  audio: 'audio',
  video: 'video',
  video_note: 'video',
  sticker: undefined,
};

function mapAttachments(atts: TelegramAttachment[] | null | undefined): ConversationAttachment[] {
  const out: ConversationAttachment[] = [];
  for (const a of atts ?? []) {
    const kind = TG_KIND[a.kind];
    if (!kind) continue;
    out.push({
      kind,
      ...(a.mime ? { mime: a.mime } : {}),
      ...(a.name ? { caption: a.name } : {}),
      ...(a.file_id ? { fileId: a.file_id } : {}),
    });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!OWNER_ID) {
    console.error('backfill-conversation: ALLOWED_USER_ID must be set');
    process.exit(1);
  }

  // 1. chatPk → responder agent, for every Telegram chat the owner has.
  const chats = await db
    .select({
      chatPk: telegramChats.id,
      telegramChatId: telegramChats.telegramChatId,
      overrideAgentId: telegramChats.responderAgentId,
      channelAgentId: channels.agentId,
    })
    .from(telegramChats)
    .innerJoin(telegramAccounts, eq(telegramChats.accountId, telegramAccounts.id))
    .leftJoin(channels, eq(telegramAccounts.channelId, channels.id))
    .where(eq(telegramChats.userId, OWNER_ID));
  const chatAgent = new Map<string, AgentRef>();
  for (const c of chats) {
    const a = await resolveChatAgent(OWNER_ID, c.overrideAgentId, c.channelAgentId);
    if (a) chatAgent.set(c.chatPk, a);
  }

  // 2. Idempotency: which telegram rows are already in the unified stream.
  const existing = await db
    .select({ ref: assistantMessages.externalRef })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.ownerId, OWNER_ID), eq(assistantMessages.channel, 'telegram')));
  const seenRowIds = new Set<string>();
  const seenMsgIds = new Set<string>();
  for (const r of existing) {
    const ref = (r.ref ?? {}) as ConversationExternalRef & { telegramRowId?: string };
    if (ref.telegramRowId) seenRowIds.add(ref.telegramRowId);
    if (ref.messageId) seenMsgIds.add(ref.messageId);
  }

  // 3. All of the owner's Telegram turns, chronological.
  const tgRows = await db
    .select({
      id: telegramMessages.id,
      chatPk: telegramMessages.chatId,
      accountId: telegramMessages.accountId,
      direction: telegramMessages.direction,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
      attachments: telegramMessages.attachments,
      telegramMessageId: telegramMessages.telegramMessageId,
      digestNodeId: telegramMessages.digestNodeId,
      agentId: telegramMessages.agentId,
      modelUsed: telegramMessages.modelUsed,
      telegramChatId: telegramChats.telegramChatId,
    })
    .from(telegramMessages)
    .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
    .where(eq(telegramChats.userId, OWNER_ID))
    .orderBy(asc(telegramMessages.sentAt));

  // 4. Plan inserts.
  type Row = typeof assistantMessages.$inferInsert;
  const toInsert: Row[] = [];
  let skippedExisting = 0;
  let skippedNoAgent = 0;
  for (const tg of tgRows) {
    if (seenRowIds.has(tg.id)) {
      skippedExisting++;
      continue;
    }
    if (tg.telegramMessageId && seenMsgIds.has(tg.telegramMessageId)) {
      skippedExisting++;
      continue;
    }
    // Outbound rows carry their own (recorded) agent id — most accurate. Inbound
    // rows fall back to the chat's resolved responder.
    const agentId =
      tg.direction === 'outbound' && tg.agentId ? tg.agentId : chatAgent.get(tg.chatPk)?.id;
    if (!agentId) {
      skippedNoAgent++;
      continue;
    }
    const externalRef: ConversationExternalRef & { telegramRowId: string } = {
      accountId: tg.accountId,
      chatId: tg.telegramChatId,
      ...(tg.telegramMessageId ? { messageId: tg.telegramMessageId } : {}),
      telegramRowId: tg.id,
    };
    toInsert.push({
      ownerId: OWNER_ID,
      agentId,
      direction: tg.direction,
      text: tg.text,
      channel: 'telegram',
      model: tg.direction === 'outbound' ? tg.modelUsed : null,
      attachments: mapAttachments(tg.attachments),
      externalRef,
      digestNodeId: tg.digestNodeId ?? null,
      createdAt: tg.sentAt, // preserve chronology in the unified stream
    });
  }

  // 5. Plan digest re-key (conversation-digest notes missing data.agent_id).
  const digestNotes = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, OWNER_ID),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
        sql`(${nodes.data}->>'agent_id') is null`,
      ),
    );
  const rekeys: { id: string; agentId: string; agentSlug: string }[] = [];
  let digestNoAgent = 0;
  for (const note of digestNotes) {
    const data = (note.data ?? {}) as Record<string, unknown>;
    let agent: AgentRef | null = null;
    const chatId = typeof data.chat_id === 'string' ? data.chat_id : null;
    if (chatId && chatAgent.has(chatId)) {
      agent = chatAgent.get(chatId)!;
    } else {
      // Web digest (or chat no longer resolvable): the majority agent among the
      // turns that point at this digest.
      const [maj] = await db
        .select({ agentId: assistantMessages.agentId, n: sql<number>`count(*)::int` })
        .from(assistantMessages)
        .where(eq(assistantMessages.digestNodeId, note.id))
        .groupBy(assistantMessages.agentId)
        .orderBy(sql`count(*) desc`)
        .limit(1);
      if (maj?.agentId) {
        const [a] = await db
          .select({ slug: agents.slug })
          .from(agents)
          .where(eq(agents.id, maj.agentId))
          .limit(1);
        agent = { id: maj.agentId, slug: a?.slug ?? maj.agentId };
      }
    }
    if (agent) rekeys.push({ id: note.id, agentId: agent.id, agentSlug: agent.slug });
    else digestNoAgent++;
  }

  // ── Report ──
  console.log('— backfill-conversation plan —');
  console.log(`chats resolved to an agent: ${chatAgent.size}/${chats.length}`);
  console.log(`telegram turns: ${tgRows.length} total`);
  console.log(`  → insert:            ${toInsert.length}`);
  console.log(`  → already backfilled: ${skippedExisting}`);
  console.log(`  → no agent (skipped): ${skippedNoAgent}`);
  console.log(`digests missing agent_id: ${digestNotes.length}`);
  console.log(`  → re-key:            ${rekeys.length}`);
  console.log(`  → unresolvable:      ${digestNoAgent}`);
  if (toInsert.length > 0) {
    const sample = toInsert.slice(0, 3).map((r) => ({
      dir: r.direction,
      ch: r.channel,
      at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      text: String(r.text).slice(0, 50),
    }));
    console.log('sample inserts:', JSON.stringify(sample, null, 2));
  }

  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to write.');
    process.exit(0);
  }

  if (toInsert.length === 0 && rekeys.length === 0) {
    console.log('\nNothing to do.');
    process.exit(0);
  }

  // ── Apply ──
  // Disable the summarize trigger for the insert burst (catalog-level, all
  // sessions) so the backfill doesn't kick off summarization mid-run; re-enable
  // in finally. If this process is hard-killed between disable and enable, the
  // trigger stays disabled — re-enable manually with:
  //   ALTER TABLE assistant_messages ENABLE TRIGGER assistant_messages_summarize_due_trg;
  let disabled = false;
  try {
    if (toInsert.length > 0) {
      await db.execute(
        sql`alter table assistant_messages disable trigger ${sql.raw(SUMMARIZE_TRIGGER)}`,
      );
      disabled = true;
      const BATCH = 500;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        await db.insert(assistantMessages).values(toInsert.slice(i, i + BATCH));
      }
      console.log(`✓ inserted ${toInsert.length} turns`);
    }
    // Re-key digests (UPDATE — does not fire node_ingested).
    for (const rk of rekeys) {
      await db
        .update(nodes)
        .set({
          data: sql`${nodes.data} || ${JSON.stringify({ agent_id: rk.agentId, agent_slug: rk.agentSlug })}::jsonb`,
        })
        .where(eq(nodes.id, rk.id));
    }
    if (rekeys.length > 0) console.log(`✓ re-keyed ${rekeys.length} digests`);
  } finally {
    if (disabled) {
      await db.execute(
        sql`alter table assistant_messages enable trigger ${sql.raw(SUMMARIZE_TRIGGER)}`,
      );
      console.log('✓ re-enabled summarize trigger');
    }
  }
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

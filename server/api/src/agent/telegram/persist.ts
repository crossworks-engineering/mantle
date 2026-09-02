/**
 * Telegram turn, stage: persistence. Delivered → one transport row per sent
 * chunk (with its Telegram id); failed → a single row with a null id, flagged
 * undelivered (recoverable). The outbound is mirrored ONCE into the unified
 * per-agent conversation stream. Split out of runtime.ts on 2026-09-02
 * (audit, bloat B2).
 */
import { db, nodes, telegramMessages, type Agent, type TelegramAccount } from '@mantle/db';
import { recordTurn } from '@mantle/runtime/agent';
import type { ResponderLoopResult } from '@mantle/runtime/assistant';
import { step } from '@mantle/tracing';
import type { Delivery } from './deliver';
import type { InboundRow } from './types';

export async function persistOutbound(args: {
  ownerId: string;
  row: InboundRow;
  account: TelegramAccount;
  agent: Agent;
  reply: string;
  delivery: Delivery;
  outcome: Pick<ResponderLoopResult, 'persistedThoughts' | 'toolStats'>;
}): Promise<void> {
  const { ownerId, row, account, agent, reply, delivery, outcome } = args;
  const { telegramMessageIds, delivered, sendError } = delivery;
  await step({ name: 'persist_outbound', kind: 'db_write' }, async (h) => {
    const now = new Date();
    const titleStem = reply.slice(0, 120);
    const targets: (number | null)[] = delivered ? telegramMessageIds : [null];
    for (const tgMsgId of targets) {
      const [node] = await db
        .insert(nodes)
        .values({
          ownerId,
          type: 'telegram_message',
          title: titleStem,
          path: account.branchPath,
          data: {
            direction: 'outbound',
            model: agent.model,
            agent: agent.slug,
            replyToTelegramMessageId: row.telegramMessageId,
            delivered,
          },
          tags: ['telegram', 'outbound'],
        })
        .returning({ id: nodes.id });
      if (!node) throw new Error('failed to create outbound node');

      await db.insert(telegramMessages).values({
        nodeId: node.id,
        accountId: row.accountId,
        chatId: row.chatPk,
        telegramMessageId: tgMsgId == null ? null : String(tgMsgId),
        text: reply,
        sentAt: now,
        direction: 'outbound',
        agentId: agent.id,
        modelUsed: agent.model,
        replyToId: row.id,
        delivered,
        processed: true,
        processedAt: now,
      });
    }

    // Mirror the outbound into the unified per-agent stream ONCE (the
    // full reply text — the per-chunk telegram_messages rows above are
    // the transport record). channel='telegram'; external_ref points at
    // the first sent chunk for reply threading. See docs/conversation.md.
    // The thought trail (b4, prefs-gated) + tool-outcome ledger (b5)
    // land on the row's data jsonb — the same keys the web path
    // persists via updateAssistantMessageOutcome, so /assistant renders
    // Telegram turns' records identically.
    await recordTurn({
      ownerId,
      agentId: agent.id,
      direction: 'outbound',
      text: reply,
      channel: 'telegram',
      model: agent.model,
      externalRef: {
        accountId: row.accountId,
        chatId: row.telegramChatId,
        ...(delivered && telegramMessageIds[0] != null
          ? { messageId: String(telegramMessageIds[0]) }
          : {}),
      },
      ...(outcome.persistedThoughts.length > 0 || outcome.toolStats
        ? {
            data: {
              ...(outcome.persistedThoughts.length > 0
                ? { thoughts: outcome.persistedThoughts }
                : {}),
              ...(outcome.toolStats ? { toolStats: outcome.toolStats } : {}),
            },
          }
        : {}),
    });
    h.setMeta({ rows: targets.length, delivered, ...(sendError ? { sendError } : {}) });
  });
}

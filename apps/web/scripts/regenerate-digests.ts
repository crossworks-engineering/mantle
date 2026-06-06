/**
 * One-off repair for conversation-digest notes whose summary was
 * clobbered by the extractor.
 *
 * The bug (now fixed in apps/agent): the summarizer wrote the digest to
 * data.summary with no data.content and no embedding, so the extractor
 * re-ran, found no body, summarised the *title*, and overwrote
 * data.summary with a useless paraphrase. The real digest was lost from
 * the node — but the original turns still exist in telegram_messages.
 *
 * This script re-summarises each corrupted digest's original turns and
 * writes data.content + data.summary back IN PLACE (an UPDATE — which
 * does NOT fire node_ingested, so the extractor never touches it).
 *
 * Corrupted digests are detected by `data.content IS NULL`: digests
 * created after the fix carry data.content; the clobbered ones don't.
 *
 * Usage:
 *   pnpm -C apps/web regenerate:digests            # repair
 *   pnpm -C apps/web regenerate:digests --dry-run  # list, don't write
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, nodes, telegramMessages, getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { buildChatMessages, flattenChatMessagesForAdapter } from '@mantle/agent-runtime';
import { getChatAdapter } from '@mantle/voice';

const OWNER_ID = process.env.ALLOWED_USER_ID;

const REGEN_PROMPT = `You are a memory compressor for an ongoing Telegram conversation. You will be given a chronological transcript of a chat between the user and an AI assistant, each line prefixed by its turn number.

Write a single factual summary of the whole transcript in 3-6 sentences (no headers, no bullet lists) capturing decisions, commitments, specific facts about people/places/dates/numbers, and notable shifts in tone. Be specific — use names, dates, and numbers; write "Maria is presenting the Q3 report on Thursday" not "they discussed work plans". Skip conversational filler.

Output ONLY the summary text — no preamble, no JSON, no markdown.`;

// (summaryText helper retired with the OpenRouter SDK direct call —
//  the typed ChatResult now carries `text` directly.)

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!OWNER_ID) {
    console.error('regenerate-digests: ALLOWED_USER_ID must be set');
    process.exit(1);
  }

  const worker = await getDefaultWorker(OWNER_ID, 'summarizer');
  if (!worker?.apiKeyId) {
    console.error('regenerate-digests: no default summarizer worker with an api key');
    process.exit(1);
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    console.error(`regenerate-digests: api_key_id ${worker.apiKeyId} not decryptable`);
    process.exit(1);
  }
  const adapter = getChatAdapter(worker.provider);
  if (!adapter) {
    console.error(
      `regenerate-digests: no chat adapter for provider '${worker.provider}'`,
    );
    process.exit(1);
  }

  // Corrupted digests = conversation-digest notes with no data.content.
  const digests = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, OWNER_ID),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
        sql`${nodes.data}->>'content' IS NULL`,
      ),
    );

  console.log(
    `regenerate-digests: ${digests.length} corrupted digest(s) found${dryRun ? ' (dry run)' : ''}`,
  );

  let repaired = 0;
  let skipped = 0;
  for (const d of digests) {
    const turns = await db
      .select({
        direction: telegramMessages.direction,
        text: telegramMessages.text,
        sentAt: telegramMessages.sentAt,
        fromName: telegramMessages.fromName,
      })
      .from(telegramMessages)
      .where(eq(telegramMessages.digestNodeId, d.id))
      .orderBy(asc(telegramMessages.sentAt));

    if (turns.length === 0) {
      console.warn(`  · ${d.title} — no source turns linked, cannot regenerate (skipped)`);
      skipped++;
      continue;
    }

    const transcript = turns
      .map((t, i) => {
        const who = t.direction === 'outbound' ? 'assistant' : (t.fromName ?? 'user');
        return `#${i + 1} [${t.sentAt.toISOString()}] ${who}: ${t.text}`;
      })
      .join('\n');

    if (dryRun) {
      console.log(`  · ${d.title} — would regenerate from ${turns.length} turns`);
      continue;
    }

    const messages = buildChatMessages({
      model: worker.model,
      provider: worker.provider,
      systemPrompt: REGEN_PROMPT,
      personaNotes: [],
      facts: [],
      digests: [],
      contentHits: [],
      history: [],
      newUserText: transcript,
    });
    const result = await adapter.chat({
      apiKey,
      model: worker.model,
      messages: flattenChatMessagesForAdapter(messages),
    });
    const summary = result.text.trim();
    if (!summary) {
      console.warn(`  · ${d.title} — LLM returned empty summary (skipped)`);
      skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const newData = {
      ...((d.data ?? {}) as Record<string, unknown>),
      content: summary,
      summary,
      summary_model: worker.model,
      summary_at: now,
      regenerated_at: now,
    };
    await db.update(nodes).set({ data: newData, updatedAt: new Date() }).where(eq(nodes.id, d.id));
    console.log(`  ✓ ${d.title} — regenerated from ${turns.length} turns (${summary.length}c)`);
    repaired++;
  }

  console.log(
    `regenerate-digests: done — ${repaired} repaired, ${skipped} skipped${dryRun ? ' (dry run, nothing written)' : ''}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('regenerate-digests failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

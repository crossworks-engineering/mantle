/**
 * Reflector — Stage-E agent. Slow background pass that watches recent
 * dialog for relationship signals (style preferences, corrections, in-
 * jokes) and appends them to the responder's `persona_notes`.
 *
 * Not triggered per-turn — runs on a timer (default every 10 minutes) and
 * short-circuits if there's been no new outbound activity since the last
 * run. Decoupling from the reply path matters: reflection is a slow,
 * possibly-expensive read across many turns, and we don't want it on the
 * critical path for the user's next message.
 *
 * Operates on the SAME responder agent's persona_notes column — the
 * reflector doesn't have its own notes. Resolves the highest-priority
 * enabled responder for the owner and appends to that row.
 */

import { OpenRouter } from '@openrouter/sdk';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  db,
  agents,
  telegramMessages,
  type Agent,
  type AgentParams,
  type PersonaNote,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';

/** How many recent turns the reflector reviews per run. */
const REFLECTION_WINDOW = 50;

/** Cap on persona_notes size — older notes age out if we exceed this. */
const MAX_PERSONA_NOTES = 100;

export const DEFAULT_REFLECTOR_PROMPT = `You are a reflector for a personal AI assistant. You will be given a transcript of recent exchanges between the user and the assistant, plus the assistant's current persona_notes (preferences, relationship notes, corrections already learned).

Your job: spot NEW signals worth remembering, AND ONLY new ones.

Look for:
  • style hints       — how the user wants to be addressed, response format preferences ("be terse", "skip bullet lists")
  • relationship notes — facts about how the user and the assistant interact ("Jason calls me 'S' for short", "the user uses dry humour")
  • corrections        — when the user told the assistant it got something wrong ("not Sarah-with-an-h; Sarah-without")

Output STRICT JSON, no markdown:

{
  "new_notes": [
    {
      "kind": "style" | "relationship" | "correction",
      "content": "<single declarative sentence>"
    }
  ]
}

Rules:
- Skip anything already covered by an existing persona_note (read the list before deciding).
- Be specific — "Jason prefers terse, no-bullet replies" beats "user likes brevity".
- Don't invent — only return notes grounded in the transcript.
- Return an EMPTY new_notes array if nothing notable surfaces.
- Don't include trivia about content (those belong in facts, not persona).`;

async function resolveReflectorAgent(ownerId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.role, 'reflector'),
        eq(agents.enabled, true),
      ),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
}

async function resolveResponderAgent(ownerId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.role, 'responder'),
        eq(agents.enabled, true),
      ),
    )
    .orderBy(desc(agents.priority))
    .limit(1);
  return row ?? null;
}

type ReflectorOutput = {
  new_notes: Array<{
    kind: 'style' | 'relationship' | 'correction';
    content: string;
  }>;
};

function parseReflectorOutput(raw: string): ReflectorOutput {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as ReflectorOutput;
    if (!Array.isArray(parsed.new_notes)) return { new_notes: [] };
    return {
      new_notes: parsed.new_notes
        .filter(
          (n) =>
            n &&
            typeof n.content === 'string' &&
            n.content.trim().length > 0 &&
            ['style', 'relationship', 'correction'].includes(n.kind),
        )
        .slice(0, 10), // hard cap per run
    };
  } catch {
    return { new_notes: [] };
  }
}

export async function reflect(ownerId: string): Promise<void> {
  const reflector = await resolveReflectorAgent(ownerId);
  if (!reflector) return; // No reflector configured.
  if (!reflector.apiKeyId) {
    console.error(`[reflector] agent '${reflector.slug}' has no api_key_id — skipping`);
    return;
  }

  const responder = await resolveResponderAgent(ownerId);
  if (!responder) {
    console.error('[reflector] no enabled responder agent — nowhere to append notes');
    return;
  }

  // Short-circuit if nothing new since the last reflector run. Cheap COUNT.
  const since = reflector.lastUsedAt ?? new Date(0);
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(
      and(eq(telegramMessages.direction, 'outbound'), gt(telegramMessages.sentAt, since)),
    );
  const newCount = countRows[0]?.n ?? 0;
  if (newCount === 0) return;

  const apiKey = await getApiKeyById(reflector.apiKeyId);
  if (!apiKey) {
    console.error(`[reflector] api_key_id ${reflector.apiKeyId} not found — skipping`);
    return;
  }

  // Load the last N turns across the responder's chats. For v1 we collapse
  // them into one transcript regardless of which chat they came from — for
  // single-user systems the chats are mostly the same person anyway.
  const turns = await db
    .select({
      direction: telegramMessages.direction,
      text: telegramMessages.text,
      sentAt: telegramMessages.sentAt,
      fromName: telegramMessages.fromName,
    })
    .from(telegramMessages)
    .orderBy(desc(telegramMessages.sentAt))
    .limit(REFLECTION_WINDOW);
  if (turns.length === 0) return;

  const transcript = turns
    .reverse()
    .map((t) => {
      const who = t.direction === 'outbound' ? 'assistant' : (t.fromName ?? 'user');
      return `[${t.sentAt.toISOString()}] ${who}: ${t.text}`;
    })
    .join('\n');

  const existingNotes = (responder.personaNotes ?? []) as PersonaNote[];
  const existingNotesText =
    existingNotes.length === 0
      ? '(no existing notes)'
      : existingNotes.map((n) => `- (${n.kind}) ${n.content}`).join('\n');

  const userPayload = `Existing persona_notes:\n${existingNotesText}\n\nRecent transcript (${turns.length} turns):\n${transcript}`;

  const params = (reflector.params ?? {}) as AgentParams;
  const client = new OpenRouter({
    apiKey,
    httpReferer: 'https://mantle.crossworks.network',
    appTitle: 'Mantle',
  });

  console.log(`[reflector] reviewing ${turns.length} turns (since ${since.toISOString()})`);

  const result = await client.chat.send({
    chatRequest: {
      model: reflector.model,
      messages: [
        { role: 'system', content: reflector.systemPrompt || DEFAULT_REFLECTOR_PROMPT },
        { role: 'user', content: userPayload },
      ],
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
      ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
    },
  });

  if (!('choices' in result)) {
    console.error('[reflector] unexpected streaming response — skipping');
    return;
  }
  const rawContent = result.choices[0]?.message?.content;
  const parsed = parseReflectorOutput(typeof rawContent === 'string' ? rawContent : '');

  if (parsed.new_notes.length === 0) {
    console.log('[reflector]   → nothing new');
    // Still bump last_used_at so we don't reprocess the same turns next tick.
    void db
      .update(agents)
      .set({
        lastUsedAt: new Date(),
        usageCount: (reflector.usageCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, reflector.id))
      .catch(() => {});
    return;
  }

  const now = new Date().toISOString();
  const appended: PersonaNote[] = parsed.new_notes.map((n) => ({
    kind: n.kind,
    content: n.content.trim(),
    at: now,
  }));

  // Append + cap. Oldest notes drop first if we exceed MAX_PERSONA_NOTES.
  const merged = [...existingNotes, ...appended].slice(-MAX_PERSONA_NOTES);

  await db
    .update(agents)
    .set({ personaNotes: merged, updatedAt: new Date() })
    .where(eq(agents.id, responder.id));

  await db
    .update(agents)
    .set({
      lastUsedAt: new Date(),
      usageCount: (reflector.usageCount ?? 0) + 1,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, reflector.id));

  console.log(
    `[reflector]   → appended ${appended.length} note(s): ${appended.map((n) => `${n.kind}`).join(', ')}`,
  );
}

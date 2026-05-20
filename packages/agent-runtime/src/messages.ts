/**
 * Build the OpenRouter `messages` array for the responder agent.
 *
 * Cache-control strategy for `anthropic/*` models — three of Anthropic's
 * four allowed breakpoints used here:
 *
 *   1. persona + persona_notes + profile facts  — stable for hours/days
 *   2. conversation_digest block                — stable until next digest
 *   3. content_index hits (if any)              — vary by user query
 *      (no breakpoint here; this block + raw turns just drift)
 *
 * Other providers either auto-cache (openai/*, deepseek/*) or ignore
 * the markers entirely. Sending them is always harmless.
 *
 * Prompt order (top-down, durable to volatile):
 *   [persona + style/relationship notes]      ← cache breakpoint 1
 *   [profile — top-K facts]
 *   [conversation_digest — last N]            ← cache breakpoint 2
 *   [content_index hits — when query mentions content]
 *   [recent turns — last N raw]
 *   [new user message]
 */

import { activeNotes, noteRef, type PersonaNote } from '@mantle/db';

export type HistoryTurn = { role: 'user' | 'assistant'; text: string };

export type Digest = {
  summary: string;
  periodStart: string;
  periodEnd: string;
  /** Topic label assigned by the summarizer, e.g. "Lister Gantry Rebuild".
   *  Null/empty when a digest was produced before topic emergence shipped,
   *  or when the summarizer saw a single-topic batch and didn't bother. */
  topic?: string | null;
};

export type FactSnippet = {
  content: string;
  kind: string;
  entityName?: string | null;
};

export type ContentHit = {
  title: string;
  type: string;
  summary: string | null;
  nodeId: string;
};

/** Tool call request emitted by the assistant. Matches the OpenRouter
 *  ChatToolCall shape — id + function name + JSON-stringified arguments. */
export type ToolCallRequest = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | {
      role: 'system';
      content:
        | string
        | Array<{ type: 'text'; text: string; cacheControl?: { type: 'ephemeral' } }>;
    }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; content: string };

export function buildChatMessages(args: {
  model: string;
  systemPrompt: string;
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  digests: Digest[];
  contentHits: ContentHit[];
  history: HistoryTurn[];
  newUserText: string;
}): ChatMessage[] {
  const {
    model,
    systemPrompt,
    personaNotes,
    facts,
    digests,
    contentHits,
    history,
    newUserText,
  } = args;

  const supportsExplicitCache = model.startsWith('anthropic/');
  const ephemeral = { type: 'ephemeral' as const };

  // ─── Block 1: persona + persona_notes + profile facts ─────────────────
  const personaBlock = renderPersonaBlock(systemPrompt, personaNotes, facts);
  const messages: ChatMessage[] = [
    supportsExplicitCache
      ? {
          role: 'system',
          content: [{ type: 'text', text: personaBlock, cacheControl: ephemeral }],
        }
      : { role: 'system', content: personaBlock },
  ];

  // ─── Block 2: conversation digests (own breakpoint) ───────────────────
  if (digests.length > 0) {
    const body = digests
      .map((d) => {
        const head = d.topic
          ? `[${d.periodStart} → ${d.periodEnd}] topic: ${d.topic}`
          : `[${d.periodStart} → ${d.periodEnd}]`;
        return `${head}\n${d.summary}`;
      })
      .join('\n\n');
    const digestText = `Earlier in this conversation (summarised):\n\n${body}`;
    messages.push(
      supportsExplicitCache
        ? {
            role: 'system',
            content: [{ type: 'text', text: digestText, cacheControl: ephemeral }],
          }
        : { role: 'system', content: digestText },
    );
  }

  // ─── Block 3: content_index hits (no cache; varies per query) ─────────
  if (contentHits.length > 0) {
    const lines = contentHits
      .map((h) => {
        const tag = `${h.type}#${h.nodeId.slice(0, 8)}`;
        const summary = h.summary ? ` — ${h.summary}` : '';
        return `• "${h.title}" (${tag})${summary}`;
      })
      .join('\n');
    const text = `Possibly relevant items the user may be referencing (refer to them by title if helpful):\n${lines}`;
    messages.push({ role: 'system', content: text });
  }

  // ─── Block 4: raw recent turns ────────────────────────────────────────
  messages.push(
    ...history.map((t): ChatMessage =>
      t.role === 'user'
        ? { role: 'user', content: t.text }
        : { role: 'assistant', content: t.text },
    ),
    { role: 'user', content: newUserText },
  );

  return messages;
}

function renderPersonaBlock(
  systemPrompt: string,
  notes: PersonaNote[],
  facts: FactSnippet[],
): string {
  const parts: string[] = [systemPrompt.trim()];

  // Only inject active (non-retired) notes. The [ref] tag lets the model
  // name a note in update_persona's supersede_refs/remove_refs when the
  // user asks for a change that contradicts one.
  const live = activeNotes(notes);
  if (live.length > 0) {
    const noteLines = live
      .map((n) => `- [${noteRef(n)}] (${n.kind}) ${n.content}`)
      .join('\n');
    parts.push(
      `\nWhat you've learned about how this user wants to be helped (each tagged with a [ref] you can pass to update_persona):\n${noteLines}`,
    );
  }

  if (facts.length > 0) {
    const factLines = facts
      .map((f) => {
        const ent = f.entityName ? ` [about: ${f.entityName}]` : '';
        return `- (${f.kind}) ${f.content}${ent}`;
      })
      .join('\n');
    parts.push(
      `\nWhat you know about the user and their world (durable facts; treat as load-bearing context, not trivia):\n${factLines}`,
    );
  }

  return parts.join('\n');
}

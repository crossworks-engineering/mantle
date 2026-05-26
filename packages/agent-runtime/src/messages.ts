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
  | {
      role: 'user';
      content:
        | string
        // Multimodal: text + image part(s) for vision-capable models.
        // imageUrl is the SDK's camelCase shape (→ image_url on the wire).
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' } }
          >;
    }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** An image to attach to the new user turn (vision-capable models only). */
export type UserImage = { base64: string; mimeType: string };

/**
 * Fold an attachment's extracted text (a vision transcript for images, parsed
 * text for documents) — or a failure note — into the user's text for a
 * responder turn, and surface the saved file node id so the model can re-read
 * the original on a follow-up: `extract_from_image(node_id)` for images,
 * `file_read(node_id)` for documents. The bytes aren't kept in history.
 *
 * Shared by the web /assistant and the Telegram responder so the injected
 * marker stays byte-identical across surfaces (no drift, stable for caching).
 */
export function buildAttachmentContextText(
  userText: string,
  opts: {
    kind?: 'image' | 'file';
    transcript?: string | null;
    note?: string | null;
    nodeId?: string | null;
  },
): string {
  const base = userText.trim();
  const kind = opts.kind ?? 'image';
  const noun = kind === 'file' ? 'file' : 'image';
  const Noun = kind === 'file' ? 'File' : 'Image';
  const tool = kind === 'file' ? 'file_read' : 'extract_from_image';
  const action = kind === 'file' ? 'for the full content' : 'to look closer';
  const label = kind === 'file' ? 'Extracted text' : 'Vision analysis';
  const ref = opts.nodeId
    ? ` (saved as file node ${opts.nodeId} — call ${tool} with that node_id ${action})`
    : '';
  const transcript = opts.transcript?.trim();
  if (transcript) {
    return `${base}\n\n[Attached ${noun}${ref}. ${label}:]\n${transcript}`;
  }
  const note = opts.note?.trim();
  if (note) {
    return `${base}\n\n[${Noun} attached${ref} but couldn't be read: ${note}]`;
  }
  return ref ? `${base}\n\n[Attached ${noun}${ref}.]` : base;
}

/**
 * Reduce a `ChatMessage[]` (the rich agent-runtime shape with vision +
 * tool-call hooks) to the plain `Array<{role, content: string}>` shape
 * the chat adapter contract accepts. Used by the chat-shaped workers
 * (extractor, summarizer, reflector) for their single-turn calls
 * post-Phase 3a — they never carry images or tool messages, so the
 * flattening is lossless for them.
 *
 * Multi-modal images and tool messages are rejected here rather than
 * silently dropped — those callers belong on the 3b path (tool-loop
 * refactor), which has its own normalised dispatch. If 3a ever sees
 * such a message it means a caller wired the wrong helper.
 */
export function flattenChatMessagesForAdapter(
  messages: ChatMessage[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map((m, idx) => {
    if (m.role === 'tool') {
      throw new Error(
        `flattenChatMessagesForAdapter: tool message at index ${idx} — use the 3b tool-loop path for tool-using workers.`,
      );
    }
    if (m.role === 'assistant') {
      // Assistant content can be null when the previous step returned only
      // tool calls. The summarizer/reflector path never builds this shape,
      // so a null here means a caller bug we shouldn't paper over.
      if (m.content == null) {
        throw new Error(
          `flattenChatMessagesForAdapter: assistant message at index ${idx} has null content — likely a stray tool-loop message.`,
        );
      }
      return { role: 'assistant' as const, content: m.content };
    }
    // system + user can be string OR array. Reject multi-modal arrays
    // here for the same reason — those callers want 3b.
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    // The array form is only emitted by the tool-loop path. The 3a
    // chat workers shouldn't see it.
    throw new Error(
      `flattenChatMessagesForAdapter: ${m.role} message at index ${idx} has array content (multi-modal or cache-marked) — use the 3b tool-loop path for these callers.`,
    );
  });
}

export function buildChatMessages(args: {
  model: string;
  systemPrompt: string;
  personaNotes: PersonaNote[];
  facts: FactSnippet[];
  digests: Digest[];
  contentHits: ContentHit[];
  history: HistoryTurn[];
  newUserText: string;
  /** When set + the model is vision-capable, the new user turn becomes a
   *  multimodal message (text + image) so the model sees the picture. */
  userImage?: UserImage;
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
    userImage,
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
  );

  // The new user turn: multimodal (text + image) when an image is attached
  // and the caller passed it (caller is responsible for the vision-capable
  // check); plain text otherwise.
  if (userImage) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: newUserText },
        {
          type: 'image_url',
          imageUrl: {
            url: `data:${userImage.mimeType};base64,${userImage.base64}`,
            detail: 'auto',
          },
        },
      ],
    });
  } else {
    messages.push({ role: 'user', content: newUserText });
  }

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

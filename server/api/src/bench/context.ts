/**
 * The brain's retrieved context for one question, as TEXT: exactly the
 * memory blocks the responder would get (facts, content hits, relations,
 * passages, digests, the corpus map), rendered by the same buildChatMessages.
 * Only the persona prompt, the time line and the history are left out: the
 * benchmark asks the question cold, and states the question date itself.
 */
import { buildChatMessages, type ConversationContext } from '@mantle/runtime/agent';

type Rendered = ReturnType<typeof buildChatMessages>[number];

const textOf = (m: Rendered): string =>
  m.content == null
    ? ''
    : typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')).join('');

/**
 * `withCorpusMap: false` leaves out the corpus map (the list of every
 * item's title). The evidence check needs that: in a benchmark brain of a few
 * dozen notes the map names every session, so any title would "reach" the
 * context whether retrieval found it or not.
 */
export function renderContext(
  ctx: ConversationContext,
  model: string,
  opts: { withCorpusMap?: boolean } = {},
): string {
  const messages = buildChatMessages({
    model,
    systemPrompt: '',
    personaNotes: ctx.personaNotes,
    journalRelevant: ctx.journalRelevant,
    facts: ctx.facts,
    digests: ctx.digests,
    corpusMap: opts.withCorpusMap === false ? undefined : ctx.corpusMap,
    contentHits: ctx.contentHits,
    chunkHits: ctx.chunkHits,
    relations: ctx.relations,
    history: [],
    newUserText: '',
  });
  // Block 0 is the persona prompt (empty here, plus the standing data rule);
  // the last message is the (empty) user turn.
  return messages
    .slice(1)
    .filter((m) => m.role === 'system')
    .map(textOf)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '@mantle/runtime/agent';
import { renderContext } from './context';
import { evidenceFound } from './prompts';

const ctx = {
  personaNotes: [],
  journalRelevant: '',
  facts: [],
  digests: [],
  contentHits: [],
  relations: [],
  corpusMap: {
    entries: [1, 2, 3].map((n) => ({
      nodeId: `n${n}`,
      type: 'note',
      title: `Conversation ${n}, Monday 1 May 2023, 1:00 pm UTC`,
      branch: 'notes',
      summary: null,
    })),
    truncated: false,
  },
  chunkHits: [
    {
      nodeId: 'n2',
      title: 'Conversation 2, Monday 1 May 2023, 1:00 pm UTC',
      heading: null,
      text: 'Ann: I moved from Sweden.',
    },
  ],
} as unknown as ConversationContext;

describe('renderContext', () => {
  it('renders the memory blocks, corpus map included, as the responder sees them', () => {
    const text = renderContext(ctx, 'google/gemini-3.5-flash-lite');
    expect(text).toContain('Conversation 3,');
    expect(text).toContain('Ann: I moved from Sweden.');
  });

  it('leaves the corpus map out for the evidence check, so a title only it lists does not count', () => {
    const retrieved = renderContext(ctx, 'm', { withCorpusMap: false });
    expect(evidenceFound(retrieved, [1])).toBe(1); // Conversation 2: a passage
    expect(evidenceFound(retrieved, [2])).toBe(0); // Conversation 3: only in the map
    expect(evidenceFound(renderContext(ctx, 'm'), [2])).toBe(1); // what the old check counted
  });
});

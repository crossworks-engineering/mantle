/**
 * Which node ids a recorded team turn used (the shadow report's input).
 */
import { describe, expect, it } from 'vitest';
import { idsUsedByStep } from './access-shadow';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('idsUsedByStep', () => {
  it('takes content hits and passages from the retrieval snapshot', () => {
    const ids = idsUsedByStep({
      name: 'load_context',
      input: {},
      output: {
        snapshot: {
          contentHits: { sent: [{ nodeId: A }, { nodeId: null }] },
          chunkHits: { sent: [{ nodeId: B }] },
          facts: { sent: [{ text: `about ${C}` }] },
        },
      },
    });
    expect(ids).toEqual([A, B]);
  });

  it('takes every id a tool was called with', () => {
    expect(idsUsedByStep({ name: 'tool: node_read', input: { node_id: C }, output: {} })).toEqual([
      C,
    ]);
  });

  it('ignores model calls and other steps', () => {
    expect(idsUsedByStep({ name: 'fake-chat_chat', input: { x: A }, output: {} })).toEqual([]);
  });
});

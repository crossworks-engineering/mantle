import { describe, expect, it } from 'vitest';
import { AgentMemoryConfigSchema, splitMemoryConfigPatch } from './agent-memory-config-schema';

describe('AgentMemoryConfigSchema', () => {
  it('accepts the corpus map size in range and refuses it outside', () => {
    expect(AgentMemoryConfigSchema.safeParse({ corpus_map_chars: 6_500 }).success).toBe(true);
    expect(AgentMemoryConfigSchema.safeParse({ corpus_map_chars: 999 }).success).toBe(false);
    expect(AgentMemoryConfigSchema.safeParse({ corpus_map_chars: 50_001 }).success).toBe(false);
  });

  it('takes null on every key (clear), and still refuses unknown keys', () => {
    const allNull = Object.fromEntries(
      Object.keys(AgentMemoryConfigSchema.shape).map((k) => [k, null]),
    );
    expect(AgentMemoryConfigSchema.safeParse(allNull).success).toBe(true);
    expect(AgentMemoryConfigSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe('splitMemoryConfigPatch', () => {
  it('sends values to set and nulls to clear, and skips undefined', () => {
    expect(
      splitMemoryConfigPatch({
        corpus_map_chars: null,
        history_limit: 20,
        delegate_to: [],
        fact_limit: undefined,
      }),
    ).toEqual({ set: { history_limit: 20, delegate_to: [] }, clear: ['corpus_map_chars'] });
  });
});

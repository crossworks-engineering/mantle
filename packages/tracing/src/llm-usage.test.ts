import { describe, expect, it } from 'vitest';
import { captureLlmUsage, recordChatUsage, type LlmUsageSink } from './llm-usage';

function mockSink() {
  const tokens: Array<{ input?: number; output?: number; cacheRead?: number }> = [];
  const costs: number[] = [];
  const meta: Record<string, unknown>[] = [];
  const sink: LlmUsageSink = {
    addTokens: (d) => tokens.push(d),
    addCost: (mu) => costs.push(mu),
    setMeta: (m) => meta.push(m),
  };
  return { sink, tokens, costs, meta };
}

describe('captureLlmUsage', () => {
  it('reads camelCase usage and prefers reported cost (USD → micro-USD)', () => {
    const { sink, tokens, costs } = mockSink();
    captureLlmUsage(
      sink,
      { usage: { promptTokens: 100, completionTokens: 50, cost: 0.0123 } },
      'perplexity/sonar-pro',
    );
    expect(tokens[0]).toEqual({ input: 100, output: 50, cacheRead: 0 });
    expect(costs[0]).toBe(12_300); // 0.0123 USD → 12300 micro-USD
  });

  it('reads snake_case usage', () => {
    const { sink, tokens } = mockSink();
    captureLlmUsage(
      sink,
      { usage: { prompt_tokens: 7, completion_tokens: 3, cache_read_input_tokens: 2 } },
      'anthropic/claude-sonnet-4.6',
    );
    expect(tokens[0]).toEqual({ input: 7, output: 3, cacheRead: 2 });
  });

  it('falls back to the static price table when no cost is reported', () => {
    const { sink, costs } = mockSink();
    // sonar-pro: 1000 in * 3e-6 + 500 out * 15e-6 = 0.003 + 0.0075 = 0.0105 USD
    captureLlmUsage(
      sink,
      { usage: { promptTokens: 1000, completionTokens: 500 } },
      'perplexity/sonar-pro',
    );
    expect(costs[0]).toBe(10_500);
  });

  it('records cost 0 for an unknown model with no reported cost', () => {
    const { sink, costs } = mockSink();
    captureLlmUsage(sink, { usage: { promptTokens: 10, completionTokens: 10 } }, 'mystery/model');
    expect(costs[0]).toBe(0);
  });

  it('writes a meta summary', () => {
    const { sink, meta } = mockSink();
    captureLlmUsage(
      sink,
      { usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 } },
      'perplexity/sonar',
    );
    expect(meta[0]).toMatchObject({
      model: 'perplexity/sonar',
      tokens_in: 10,
      tokens_out: 5,
      cost_micro_usd: 1000,
    });
  });

  it('no-ops on missing or malformed usage', () => {
    const { sink, tokens, costs } = mockSink();
    captureLlmUsage(sink, null, 'm');
    captureLlmUsage(sink, {}, 'm');
    captureLlmUsage(sink, { usage: undefined }, 'm');
    expect(tokens).toHaveLength(0);
    expect(costs).toHaveLength(0);
  });
});

describe('recordChatUsage (typed ChatResult)', () => {
  it('prefers reportedCostUsd over the static price table', () => {
    const { sink, costs, meta } = mockSink();
    recordChatUsage(
      sink,
      {
        model: 'anthropic/claude-haiku-4.5',
        tokensIn: 1000,
        tokensOut: 200,
        reportedCostUsd: 0.0012,
      },
      'anthropic/claude-haiku-4.5',
    );
    expect(costs[0]).toBe(1_200);
    expect(meta[0]).toMatchObject({
      model: 'anthropic/claude-haiku-4.5',
      tokens_in: 1000,
      tokens_out: 200,
      cost_micro_usd: 1_200,
    });
  });

  it('falls back to the static price table when reportedCostUsd is undefined', () => {
    const { sink, costs } = mockSink();
    // claude-haiku-4.5 (table): in 0.0000008 + out 0.000004 USD/token
    // 1000 * 0.0000008 + 200 * 0.000004 = 0.0008 + 0.0008 = 0.0016
    recordChatUsage(
      sink,
      { model: 'anthropic/claude-haiku-4.5', tokensIn: 1000, tokensOut: 200 },
      'anthropic/claude-haiku-4.5',
    );
    expect(costs[0]).toBe(1_600);
  });

  it('records cacheRead tokens onto the trace', () => {
    const { sink, tokens, meta } = mockSink();
    recordChatUsage(
      sink,
      {
        model: 'anthropic/claude-sonnet-4.6',
        tokensIn: 200,
        tokensOut: 50,
        cacheReadTokens: 800,
      },
      'anthropic/claude-sonnet-4.6',
    );
    // first addTokens call carries the input/output + cacheRead trio.
    expect(tokens[0]).toEqual({ input: 200, output: 50, cacheRead: 800 });
    expect(meta[0]).toMatchObject({ cache_read: 800 });
  });

  it('rolls cacheWrite into tokensIn for total billing + exposes cache_write meta', () => {
    const { sink, tokens, meta } = mockSink();
    recordChatUsage(
      sink,
      {
        model: 'anthropic/claude-sonnet-4.6',
        tokensIn: 200,
        tokensOut: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 100,
      },
      'anthropic/claude-sonnet-4.6',
    );
    // Two addTokens calls: the regular trio + the cache-write fold-in.
    expect(tokens[0]).toEqual({ input: 200, output: 50, cacheRead: 0 });
    expect(tokens[1]).toEqual({ input: 100 });
    expect(meta[0]).toMatchObject({ cache_write: 100 });
  });

  it('omits cache_write meta when cacheWriteTokens is undefined or zero', () => {
    const { sink, meta } = mockSink();
    recordChatUsage(sink, { model: 'x', tokensIn: 10, tokensOut: 5 }, 'mystery/model');
    expect(meta[0]).not.toHaveProperty('cache_write');
  });

  it('uses requestedModel for the cost-table lookup, not result.model', () => {
    const { sink, costs } = mockSink();
    // result.model echoes the served model (e.g. HF :fastest); the
    // cost table is keyed on what the worker config asked for.
    recordChatUsage(
      sink,
      {
        model: 'served-by-some-subprovider',
        tokensIn: 1000,
        tokensOut: 200,
      },
      'anthropic/claude-haiku-4.5',
    );
    // Same numbers as the fallback-table test above — same requested model.
    expect(costs[0]).toBe(1_600);
  });

  it('handles missing token counts gracefully (provider returned nothing)', () => {
    const { sink, tokens, costs } = mockSink();
    recordChatUsage(sink, { model: 'm' }, 'mystery/model');
    expect(tokens[0]).toEqual({ input: 0, output: 0, cacheRead: 0 });
    expect(costs[0]).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { captureLlmUsage, type LlmUsageSink } from './llm-usage';

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
    captureLlmUsage(sink, { usage: { promptTokens: 1000, completionTokens: 500 } }, 'perplexity/sonar-pro');
    expect(costs[0]).toBe(10_500);
  });

  it('records cost 0 for an unknown model with no reported cost', () => {
    const { sink, costs } = mockSink();
    captureLlmUsage(sink, { usage: { promptTokens: 10, completionTokens: 10 } }, 'mystery/model');
    expect(costs[0]).toBe(0);
  });

  it('writes a meta summary', () => {
    const { sink, meta } = mockSink();
    captureLlmUsage(sink, { usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 } }, 'perplexity/sonar');
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

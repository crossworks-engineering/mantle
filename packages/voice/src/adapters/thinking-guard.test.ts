import { describe, it, expect } from 'vitest';
import { isToolContinuation, wantGuardedThinking } from './thinking-guard';
import type { ChatOptions } from './types';

const opts = (over: Partial<ChatOptions>): ChatOptions => ({
  apiKey: 'k',
  model: 'm',
  messages: [],
  ...over,
});

describe('isToolContinuation', () => {
  it('false for a fresh turn (system + user only)', () => {
    expect(
      isToolContinuation([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ]),
    ).toBe(false);
  });

  it('false when an assistant turn has text but no tool calls', () => {
    expect(
      isToolContinuation([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toBe(false);
  });

  it('true once the history holds an assistant tool_use turn', () => {
    expect(
      isToolContinuation([
        { role: 'user', content: 'find X' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'result' },
      ]),
    ).toBe(true);
  });
});

describe('wantGuardedThinking', () => {
  it('off when no budget', () => {
    expect(wantGuardedThinking(opts({ messages: [{ role: 'user', content: 'hi' }] }))).toBe(false);
  });

  it('on for the first round (budget set, no prior tool_use) — incl. the round that calls a tool', () => {
    expect(
      wantGuardedThinking(
        opts({ thinkingBudget: 2000, messages: [{ role: 'user', content: 'hi' }] }),
      ),
    ).toBe(true);
  });

  it('off on a tool continuation even with a budget (no echo-back → would 400)', () => {
    expect(
      wantGuardedThinking(
        opts({
          thinkingBudget: 2000,
          messages: [
            { role: 'user', content: 'find X' },
            {
              role: 'assistant',
              content: null,
              toolCalls: [{ id: 'c1', type: 'function', function: { name: 's', arguments: '{}' } }],
            },
            { role: 'tool', toolCallId: 'c1', content: 'r' },
          ],
        }),
      ),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { xaiChatAdapter } from './xai-chat';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(): Array<{ headers: Record<string, string> }> {
  const calls: Array<{ headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push({ headers: init.headers });
      return new Response(
        JSON.stringify({ model: 'grok-4', choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

describe('xai-chat cache affinity', () => {
  const base = { apiKey: 'k', model: 'grok-4', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('sends x-grok-conv-id when the caller has a conversation id', async () => {
    const calls = stubFetch();
    await xaiChatAdapter.chat({ ...base, sessionId: 'mantle-agent-a1' });
    expect(calls[0]!.headers['x-grok-conv-id']).toBe('mantle-agent-a1');
  });

  it('sends no conversation header without one', async () => {
    const calls = stubFetch();
    await xaiChatAdapter.chat(base);
    expect(calls[0]!.headers['x-grok-conv-id']).toBeUndefined();
  });
});

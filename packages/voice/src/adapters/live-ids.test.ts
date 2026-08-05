/**
 * `DiscoveryResult.liveIds` — the raw provider list, kept alongside the
 * filtered `available`.
 *
 * Every adapter that curates a catalogue computes the provider's live id set in
 * order to intersect with it, and every one of them used to discard it
 * immediately afterwards. That set is the input to the models-drift report:
 * `available` answers "which of ours are live", and only the raw list can
 * answer "which of theirs aren't ours" — the question that would have caught
 * grok-4.5.
 *
 * The absent case carries meaning too. Undefined means "we could not look",
 * which the report must never confuse with "the provider serves nothing"; the
 * latter would read as the entire catalogue having gone stale.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { anthropicChatAdapter } from './anthropic-chat';
import { deepseekChatAdapter } from './deepseek-chat';
import { googleChatAdapter } from './google-chat';
import { huggingfaceChatAdapter } from './huggingface-chat';
import { xaiChatAdapter } from './xai-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonFetch(body: unknown) {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function failFetch(status: number) {
  globalThis.fetch = (async () => ({
    ok: false,
    status,
    text: async () => 'nope',
  })) as unknown as typeof fetch;
}

describe('liveIds carries the whole provider list', () => {
  it('xai: reports an uncatalogued model rather than dropping it', async () => {
    jsonFetch({ data: [{ id: 'grok-4.3' }, { id: 'grok-9-unreleased' }] });
    const res = await xaiChatAdapter.discoverModels!('xai-test');
    expect(res.liveIds).toEqual(['grok-4.3', 'grok-9-unreleased']);
    // `available` stays the intersection — the dropdown is unchanged.
    expect(res.available.map((m) => m.id)).toEqual(['grok-4.3']);
  });

  it('deepseek: same contract', async () => {
    jsonFetch({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-brand-new' }] });
    const res = await deepseekChatAdapter.discoverModels!('sk-test');
    expect(res.liveIds).toContain('deepseek-brand-new');
  });

  it('huggingface: same contract', async () => {
    jsonFetch({ data: [{ id: 'some/model' }] });
    const res = await huggingfaceChatAdapter.discoverModels!('hf-test');
    expect(res.liveIds).toEqual(['some/model']);
  });

  it('anthropic: passes dated ids through unresolved, for the report to alias', async () => {
    jsonFetch({ data: [{ id: 'claude-opus-5-20260601' }] });
    const res = await anthropicChatAdapter.discoverModels!('sk-ant-test');
    expect(res.liveIds).toEqual(['claude-opus-5-20260601']);
  });

  it("google: only generateContent-capable ids, so the report needn't re-filter", async () => {
    jsonFetch({
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    });
    const res = await googleChatAdapter.discoverModels!('gk-test');
    expect(res.liveIds).toEqual(['gemini-2.5-flash']);
  });
});

describe('liveIds is absent when the list call failed', () => {
  it.each([
    ['xai', xaiChatAdapter],
    ['deepseek', deepseekChatAdapter],
    ['huggingface', huggingfaceChatAdapter],
    ['google', googleChatAdapter],
    ['anthropic', anthropicChatAdapter],
  ] as const)('%s', async (_name, adapter) => {
    failFetch(401);
    const res = await adapter.discoverModels!('bad-key');
    expect(res.liveIds).toBeUndefined();
    // The catalogue is still returned so the dropdown stays usable.
    expect(res.available.length).toBeGreaterThan(0);
    expect(res.filtered).toBe(false);
  });
});

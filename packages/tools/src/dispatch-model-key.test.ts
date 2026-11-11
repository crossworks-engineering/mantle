/**
 * A model provider's key stays on the model path (secret-ref-gate.ts
 * providerKeyRefusal): an http tool that carries one is refused when it is
 * made (createTool) and when it runs (dispatchHttp), before the vault is
 * read and before anything is sent. A key of any other service is not.
 *
 * Why: on 2026-11-10 a mini app's http tools sent the brain's OpenRouter key
 * to openrouter.ai; the http path never reads a reply's cost, so about $47
 * of model calls reached no trace and the cost screen showed $3.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultReads: string[] = [];
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  tools: {},
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKey: async (_owner: string, service: string, label: string) => {
    vaultReads.push(`${service}/${label}`);
    return null;
  },
}));

import type { Tool, ToolHandler } from '@mantle/db';
import { createTool } from './crud';
import { dispatchTool } from './dispatch';
import { runCaller } from './gate-callers';
import './gate-narrowers';
import { providerKeyRefusal } from './secret-ref-gate';
import type { ToolHandlerContext } from './types';

const CTX = { ownerId: 'o1', caller: runCaller() } as ToolHandlerContext;

function httpHandler(auth: string): Extract<ToolHandler, { kind: 'http' }> {
  return {
    kind: 'http',
    method: 'POST',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: auth },
    body: '{"model":"openai/gpt-6-astra"}',
  } as Extract<ToolHandler, { kind: 'http' }>;
}
const httpTool = (auth: string): Tool =>
  ({ slug: 'ask_gpt', handler: httpHandler(auth) }) as unknown as Tool;

beforeEach(() => {
  vaultReads.length = 0;
});

describe('providerKeyRefusal', () => {
  it('refuses every AI provider key, and names model_call', () => {
    for (const service of ['openrouter', 'openai', 'anthropic', 'google', 'xai', 'foundry']) {
      const refusal = providerKeyRefusal(httpHandler(`Bearer {{secret:${service}/default}}`));
      expect(refusal, service).toContain(`'${service}/default'`);
      expect(refusal, service).toContain('model_call');
    }
  });

  it('finds the key in a query, a body or the url too', () => {
    const base = httpHandler('Bearer x');
    expect(
      providerKeyRefusal({ ...base, query: { key: '{{secret:google/work}}' } }),
    ).not.toBeNull();
    expect(
      providerKeyRefusal({ ...base, body: '{"k":"{{ secret:openai/default }}"}' }),
    ).not.toBeNull();
    expect(
      providerKeyRefusal({ ...base, url: 'https://x.test/{{secret:anthropic/default}}' }),
    ).not.toBeNull();
  });

  it('lets any other key through, and every handler that is not http', () => {
    expect(providerKeyRefusal(httpHandler('Bearer {{secret:openweathermap/default}}'))).toBeNull();
    expect(providerKeyRefusal(httpHandler('Bearer {{secret:newton/default}}'))).toBeNull();
    expect(providerKeyRefusal(httpHandler('Bearer no-ref'))).toBeNull();
    expect(providerKeyRefusal({ kind: 'shell', cmd: 'echo' } as ToolHandler)).toBeNull();
  });
});

describe('an http tool with a provider key', () => {
  it('is refused at run time, before the vault is read or a request sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await dispatchTool(httpTool('Bearer {{secret:openrouter/default}}'), {}, CTX);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('model_call');
    expect(vaultReads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('with another key still reads the vault (the gate is for provider keys only)', async () => {
    const res = await dispatchTool(httpTool('Bearer {{secret:openweathermap/default}}'), {}, CTX);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('not found in the API-key vault');
    expect(vaultReads).toEqual(['openweathermap/default']);
  });

  it('is refused when it is made', async () => {
    await expect(
      createTool('o1', {
        slug: 'ask_gpt',
        name: 'Ask GPT',
        description: 'd',
        handler: httpHandler('Bearer {{secret:openrouter/default}}'),
      }),
    ).rejects.toThrow(/model_call/);
  });
});

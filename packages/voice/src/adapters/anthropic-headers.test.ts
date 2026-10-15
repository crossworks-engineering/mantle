/**
 * The Anthropic workspace id rides on EVERY Anthropic call path, from one
 * place (anthropicHeaders), and on none when the key carries none.
 *
 * Two halves (gateway lens):
 *  - behaviour: each Anthropic call this package makes (chat, streaming
 *    chat, the model list, vision on an image, vision on a PDF, the vision
 *    model list) is run against a stubbed fetch with a credential that
 *    carries a workspace id, and the request must name it; the same calls
 *    with a credential that carries none must not. Two credentials holding
 *    the SAME key value with different workspace ids each send their own,
 *    however their calls interleave (the id rides on the credential, never
 *    looked up by the key value).
 *  - structure: no product file but anthropic-headers.ts builds Anthropic
 *    headers itself. Every Anthropic request must send `anthropic-version`,
 *    so a file that writes that header name is a second gateway.
 *
 * Placeholder keys only; nothing reaches Anthropic.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anthropicChatAdapter } from './anthropic-chat';
import { anthropicVisionAdapter } from './anthropic-vision';
import {
  ANTHROPIC_WORKSPACE_HEADER,
  anthropicHeaders,
  anthropicListError,
} from './anthropic-headers';
import type { ProviderCredential } from './types';

const WS = 'wrkspc_test_gateway';
const WITH_WS: ProviderCredential = { apiKey: 'test-key-with-workspace', anthropicWorkspaceId: WS };
const WITHOUT_WS: ProviderCredential = { apiKey: 'test-key-without-workspace' };

const realFetch = globalThis.fetch;
let seen: Array<{ url: string; headers: Headers }> = [];

/** A fetch that records each request's headers and answers what the call
 *  path expects: SSE for a stream, a model list for /v1/models, else a
 *  Messages reply. */
function stubFetch() {
  seen = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { stream?: boolean }) : {};
    if (String(url).includes('/v1/models')) {
      return Response.json({ data: [{ id: 'claude-haiku-4-5' }] });
    }
    if (body.stream) {
      const frames = [
        `data: ${JSON.stringify({ type: 'message_start', message: { model: 'm', usage: {} } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          for (const f of frames) c.enqueue(enc.encode(f));
          c.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ content: [{ type: 'text', text: 'ok' }], model: 'm', usage: {} });
  }) as unknown as typeof fetch;
}

/** Every Anthropic call path this package has, with `credential`. */
async function everyCallPath(credential: ProviderCredential): Promise<string[]> {
  const names: string[] = [];
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  await anthropicChatAdapter.chat({ ...credential, model: 'claude-haiku-4-5', messages: msgs });
  names.push('chat');
  await anthropicChatAdapter.chatStream!(
    { ...credential, model: 'claude-haiku-4-5', messages: msgs },
    () => {},
  );
  names.push('chatStream');
  await anthropicChatAdapter.discoverModels!(credential);
  names.push('chat discoverModels');
  await anthropicVisionAdapter.extract(Buffer.from([1, 2, 3]), {
    ...credential,
    mimeType: 'image/png',
    prompt: 'describe',
  });
  names.push('vision extract');
  await anthropicVisionAdapter.extractDocument!(Buffer.from('%PDF-1.4'), {
    ...credential,
    mimeType: 'application/pdf',
    prompt: 'read',
  });
  names.push('vision extractDocument');
  await anthropicVisionAdapter.discoverModels!(credential);
  names.push('vision discoverModels');
  return names;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('anthropicHeaders', () => {
  it('sends the key, the version, and the workspace id only when the credential carries one', () => {
    const h = anthropicHeaders(WITH_WS, { 'content-type': 'application/json' });
    expect(h['x-api-key']).toBe(WITH_WS.apiKey);
    expect(h['anthropic-version']).toBeTruthy();
    expect(h[ANTHROPIC_WORKSPACE_HEADER]).toBe(WS);
    expect(h['content-type']).toBe('application/json');
    expect(anthropicHeaders(WITHOUT_WS)).not.toHaveProperty(ANTHROPIC_WORKSPACE_HEADER);
  });
});

describe('every Anthropic call path carries the workspace id', () => {
  it('names it on each request made with a credential that carries one', async () => {
    const paths = await everyCallPath(WITH_WS);
    expect(seen).toHaveLength(paths.length);
    seen.forEach((r, i) => {
      expect(r.headers.get(ANTHROPIC_WORKSPACE_HEADER), paths[i]).toBe(WS);
      expect(r.headers.get('x-api-key'), paths[i]).toBe(WITH_WS.apiKey);
    });
  });

  it('names none with a credential that carries none (behaviour unchanged)', async () => {
    const paths = await everyCallPath(WITHOUT_WS);
    expect(seen).toHaveLength(paths.length);
    seen.forEach((r, i) => {
      expect(r.headers.has(ANTHROPIC_WORKSPACE_HEADER), paths[i]).toBe(false);
      expect(r.headers.get('anthropic-version'), paths[i]).toBeTruthy();
    });
  });
});

describe('two rows holding the same key value', () => {
  // The bug the credential handle closes: a registry keyed by the key value
  // let the row opened last decide the workspace id for every call with that
  // value. Each credential carries its own row's id instead.
  const SAME = 'test-same-key-value';
  const rowA: ProviderCredential = { apiKey: SAME, anthropicWorkspaceId: 'wrkspc_row_a' };
  const rowB: ProviderCredential = { apiKey: SAME, anthropicWorkspaceId: 'wrkspc_row_b' };
  const rowNone: ProviderCredential = { apiKey: SAME };

  it("each call sends its own row's id, however the calls interleave", async () => {
    const order = [rowA, rowB, rowNone, rowA, rowNone, rowB];
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    for (const c of order) {
      await anthropicChatAdapter.chat({ ...c, model: 'claude-haiku-4-5', messages: msgs });
    }
    await anthropicVisionAdapter.discoverModels!(rowB);
    await anthropicChatAdapter.discoverModels!(rowA);
    await anthropicChatAdapter.discoverModels!(rowNone);
    expect(seen.map((r) => r.headers.get(ANTHROPIC_WORKSPACE_HEADER))).toEqual([
      'wrkspc_row_a',
      'wrkspc_row_b',
      null,
      'wrkspc_row_a',
      null,
      'wrkspc_row_b',
      'wrkspc_row_b',
      'wrkspc_row_a',
      null,
    ]);
    expect(new Set(seen.map((r) => r.headers.get('x-api-key')))).toEqual(new Set([SAME]));
  });
});

describe('a model list refused for want of a workspace', () => {
  it('reports the fixed sentence, not the body', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'must include the anthropic-workspace-id header',
      },
    });
    expect(anthropicListError(400, body, 'fallback')).toMatch(/not tied to a workspace/);
    expect(anthropicListError(401, '{}', 'fallback')).toBe('fallback');
  });
});

describe('one gateway', () => {
  it('no product file but anthropic-headers.ts writes the anthropic-version header', () => {
    const root = join(import.meta.dirname, '../../../..');
    const files = execFileSync('git', ['ls-files', '-z', 'packages', 'server'], { cwd: root })
      .toString()
      .split('\0')
      .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.test\.|\/test\//.test(f));
    const offenders = files.filter((f) => {
      if (f === 'packages/voice/src/adapters/anthropic-headers.ts') return false;
      // Code only: a comment may name the header.
      const code = readFileSync(join(root, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      return /['"`]anthropic-version['"`]/i.test(code);
    });
    expect(
      offenders,
      'build Anthropic headers with anthropicHeaders (@mantle/voice) instead',
    ).toEqual([]);
  });
});

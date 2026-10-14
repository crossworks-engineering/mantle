/**
 * The egress proof table for the callers in @mantle/tools (A10 part 1,
 * docs/egress.md): every caller that fetches a URL a user, a model or a
 * remote server gave, over the same seven cells (a public host, a private
 * IP, a name resolving to 127.0.0.1, a redirect to the cloud metadata
 * address, a redirect to another host carrying Authorization, an oversized
 * body, a slow server). DNS and the platform fetch are a fake network
 * (@mantle/std/egress-test-net); everything above them is the real code.
 *
 * Record, move, compare: the table was recorded on the sources before the
 * move (__snapshots__/egress-proof.before.json, never rewritten) and must
 * equal it after the move but for the NAMED changes below; the table after
 * the move is __snapshots__/egress-proof.after.json.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import {
  cellError,
  runEgressRow,
  withNamedChanges,
  type EgressTable,
  type NamedChanges,
} from '@mantle/std/egress-test-net';
import { web_fetch } from './toolsmith/web-fetch';
import { safeFetch } from './safe-fetch';
import { fetchSpecText } from './openapi-sync';
import { mcpConnectorFetch } from './mcp-client';
import { mcpOAuthFetch } from './mcp-oauth';
import { peerMcpFetch } from './builtins-peer-mcp';
import { vetVideoUrl } from './builtins-video';
import type { ToolHandlerContext } from './types';

const OK_TEXT = 'hello from the test net';
const SECRET = 'tok-SECRET-123';

afterEach(() => vi.unstubAllGlobals());

const hooks = {
  stubFetch: (f: typeof fetch) => vi.stubGlobal('fetch', f),
  timers: {
    useFakeTimers: () => vi.useFakeTimers(),
    useRealTimers: () => vi.useRealTimers(),
    advanceTimersByTimeAsync: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  },
};

async function bodyAnswer(res: Response): Promise<string> {
  const text = await res.text();
  return `status ${res.status}, ${text.length} bytes`;
}

/** Each caller, called the way its product code calls it. */
const ROWS: Record<string, (base: string) => Promise<string>> = {
  web_fetch: async (base) => {
    const r = await web_fetch.handler({ url: `${base}/docs` }, {
      ownerId: 'owner',
    } as ToolHandlerContext);
    if (!r.ok) return `error: ${r.error}`;
    const o = r.output as { status: number; totalChars: number };
    return `status ${o.status}, ${o.totalChars} chars`;
  },
  // dispatch.ts runs every http-kind API tool (and the dev console proxy,
  // the OAuth2 token endpoint) through safeFetch with its own timeout.
  'http API tool (safeFetch)': async (base) => {
    try {
      const res = await safeFetch(
        `${base}/v1/items`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${SECRET}` },
          signal: AbortSignal.timeout(30_000),
        },
        [SECRET],
      );
      return await bodyAnswer(res);
    } catch (err) {
      return cellError(err);
    }
  },
  'OpenAPI spec fetch': async (base) => {
    try {
      const { text } = await fetchSpecText(`${base}/openapi.json`);
      return `${text.length} chars`;
    } catch (err) {
      return cellError(err);
    }
  },
  'MCP connector': async (base) => {
    try {
      const res = await mcpConnectorFetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{}',
      });
      return await bodyAnswer(res);
    } catch (err) {
      return cellError(err);
    }
  },
  'MCP connector OAuth endpoints': async (base) => {
    try {
      const res = await mcpOAuthFetch(`${base}/.well-known/oauth-authorization-server`, {
        method: 'GET',
        headers: { authorization: `Basic ${SECRET}` },
      });
      return await bodyAnswer(res);
    } catch (err) {
      return cellError(err);
    }
  },
  'peer MCP transport': async (base) => {
    try {
      const res = await peerMcpFetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: '{}',
      });
      return await bodyAnswer(res);
    } catch (err) {
      return cellError(err);
    }
  },
  'video_ingest link check': async (base) => {
    const refused = await vetVideoUrl(`${base}/watch?v=1`);
    return refused ? `error: ${refused}` : 'handed to the media sidecar';
  },
};

const META_REFUSED = 'error: refusing to fetch a private/internal address (169.254.169.254)';

/** Every cell the move changes, and why. Any other difference fails. */
const NAMED: NamedChanges = {
  // The streamed cap: the same first 5 MB of text, the rest never read.
  web_fetch: { 'oversized body': { oversizedRead: 'stopped at 5 MB' } },
  // The linked peer's MCP endpoint keeps private and tailnet addresses
  // (allowLan) but a redirect into link-local space is refused.
  'peer MCP transport': {
    'redirect to 169.254.169.254': { answer: META_REFUSED, reached: ['meta-redirect.test'] },
    'oversized body': {
      answer: 'error: response body is over the 33554432-byte cap',
      oversizedRead: 'stopped at 32 MB',
    },
  },
  // Fix round 1: deadlines and byte caps where there were none. A
  // connector's reply is capped at 32 MB (the standing GET event stream
  // takes a per-event cap instead, fix round 2); the OAuth endpoints, parsed whole with res.json(), at
  // 1 MB and 30 s; the spec fetch has a 30 s deadline; a peer MCP reply is
  // capped at 32 MB, as the federation client's.
  'MCP connector': {
    'oversized body': {
      answer: 'error: response body is over the 33554432-byte cap',
      oversizedRead: 'stopped at 32 MB',
    },
  },
  'MCP connector OAuth endpoints': {
    'oversized body': {
      answer: 'error: response body is over the 1048576-byte cap',
      oversizedRead: 'stopped at 1 MB',
    },
    'slow server': { answer: 'error: This operation was aborted (after 30 s)' },
  },
  'OpenAPI spec fetch': {
    'slow server': {
      answer:
        'error: fetching the spec timed out after 30 s, check the spec URL answers (after 30 s)',
    },
  },
  // The redirect walk before the sidecar: it reaches the link itself (no
  // body read), and a redirect into private or metadata space is refused.
  // A link that does not answer within 10 s is refused (fix round 1: the
  // walk fails closed, its redirects were never checked).
  'video_ingest link check': {
    'public host': { reached: ['public.test'] },
    'redirect to 169.254.169.254': { answer: META_REFUSED, reached: ['meta-redirect.test'] },
    'redirect to another host with Authorization': {
      reached: ['cross-redirect.test', 'other.test'],
      authorizationAtOtherHost: 'not sent',
    },
    'oversized body': { reached: ['huge.test'], oversizedRead: 'stopped at 0 MB' },
    'slow server': {
      answer:
        'error: the link did not answer within 10 s, so its redirects could not be checked (after 10 s)',
      reached: ['slow.test'],
    },
  },
};

describe('egress proof table: @mantle/tools callers', () => {
  it(
    'answers each cell as before the move, but for the named changes',
    { timeout: 120_000 },
    async () => {
      const table: EgressTable = {};
      for (const [name, call] of Object.entries(ROWS)) {
        table[name] = await runEgressRow(OK_TEXT, 'text/plain', call, hooks);
      }
      const before = JSON.parse(
        readFileSync(new URL('./__snapshots__/egress-proof.before.json', import.meta.url), 'utf8'),
      ) as EgressTable;
      expect(table).toEqual(withNamedChanges(before, NAMED));
      await expect(JSON.stringify(table, null, 1) + '\n').toMatchFileSnapshot(
        './__snapshots__/egress-proof.after.json',
      );
    },
  );
});

/**
 * web_fetch — read a service's API docs before authoring against them.
 */

import { parserText } from '@mantle/files';
import { guardedFetch } from '../ssrf-guard';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { errorMessage, NET_TIMEOUTS, timeoutSignal } from '@mantle/std';
import { URL_RE } from './common';
import { CS } from '../client-sourced-rule';

const FETCH_TIMEOUT_MS = NET_TIMEOUTS.webFetch;

const FETCH_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_TEXT_CAP = 40_000;

const MAX_TEXT_CAP = 80_000;

export const web_fetch: BuiltinToolDef = {
  slug: 'web_fetch',
  usageTier: 5,
  policy: {
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    outside: { untrusted: true, egress: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.free(CS.WEB),
  },
  name: 'Fetch a web page',
  description:
    "Fetch a URL (API documentation, OpenAPI spec, reference page) and return its readable text. HTML is converted to plain text; JSON/markdown/plain text come back as-is. Long pages are truncated — pass offset to continue reading. Use this to read a service's API docs before authoring tools with api_tool_create.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to fetch' },
      offset: {
        type: 'number',
        description: 'character offset to start from (for paging long documents), default 0',
      },
      max_chars: {
        type: 'number',
        description: `characters to return, default ${DEFAULT_TEXT_CAP}, max ${MAX_TEXT_CAP}`,
      },
    },
    required: ['url'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const url = str(input.url).trim();
    if (!URL_RE.test(url)) return { ok: false, error: 'url must start with http(s)://' };
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const cap = Math.min(
      MAX_TEXT_CAP,
      Math.max(1_000, Math.floor(Number(input.max_chars) || DEFAULT_TEXT_CAP)),
    );
    try {
      // guardedFetch blocks private/loopback/link-local/metadata targets and
      // re-checks each redirect hop, so an injected agent can't turn web_fetch
      // into an SSRF probe of internal services or the cloud-metadata endpoint.
      // The body is read up to FETCH_MAX_BYTES and no further: the first
      // bytes, without holding the rest.
      const res = await guardedFetch(
        url,
        {
          signal: timeoutSignal(FETCH_TIMEOUT_MS),
          headers: { 'user-agent': 'mantle-toolsmith/1.0 (+self-hosted assistant)' },
        },
        5,
        { maxBytes: FETCH_MAX_BYTES, overflow: 'truncate' },
      );
      const clipped = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? '';
      let text: string;
      if (/html/i.test(contentType)) {
        // A page from the open web is untrusted markup: its text is taken out
        // by the parser service (the linear markup reader), never here.
        text = await parserText(clipped, 'html');
      } else {
        text = clipped.toString('utf8');
      }
      const slice = text.slice(offset, offset + cap);
      ctx.step?.setMeta({ url, status: res.status, totalChars: text.length });
      return {
        ok: true,
        output: {
          url,
          status: res.status,
          contentType,
          text: slice,
          totalChars: text.length,
          offset,
          truncated: offset + cap < text.length,
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/* ─────────────────────────── api_tool CRUD ───────────────────────── */

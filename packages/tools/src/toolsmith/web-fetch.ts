/**
 * web_fetch — read a service's API docs before authoring against them.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { parseTikaBytes } from '@mantle/files';
import { guardedFetch } from '../ssrf-guard';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import { URL_RE } from './common';

const FETCH_TIMEOUT_MS = 25_000;

const FETCH_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_TEXT_CAP = 40_000;

const MAX_TEXT_CAP = 80_000;

/** Last-resort HTML→text when Tika is down: drop scripts/styles/tags. */
function crudeHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const web_fetch: BuiltinToolDef = {
  slug: 'web_fetch',
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
      const res = await guardedFetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'mantle-toolsmith/1.0 (+self-hosted assistant)' },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const clipped = buf.subarray(0, FETCH_MAX_BYTES);
      const contentType = res.headers.get('content-type') ?? '';
      let text: string;
      if (/html/i.test(contentType)) {
        text = await parseTikaBytes(clipped, { mimeType: 'text/html' });
        if (!text) text = crudeHtmlToText(clipped.toString('utf8'));
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

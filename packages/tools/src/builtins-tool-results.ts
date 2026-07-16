/**
 * `read_result` — dereference a spilled tool result.
 *
 * When a tool returns more than the inline cap, the tool-loop stores the full
 * output and hands the model a `{_spilled:true, handle:"tr_…"}` envelope
 * instead of the raw bytes (see tool-results.ts / architecture §9l). This
 * builtin is how the model reads the rest: linearly (`page`), by substring
 * (`grep`), or semantically (`query`, which lazily chunks + embeds the result
 * on first use). Read-only; never needs confirmation. The tool-loop always
 * offers it so a handle is always dereferenceable.
 */

import type { BuiltinToolDef } from './types';
import { readResultPage, grepResult, queryResult, DEFAULT_RESULT_HANDLING } from './tool-results';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const read_result: BuiltinToolDef = {
  slug: 'read_result',
  name: 'Read a stored (large) tool result',
  description:
    "Read a tool result that was too large to inline and was stored under a handle (it came back as {_spilled:true, handle:'tr_…'}). Three modes: `query` for a semantic search within the result (best for 'find where it says X'), `grep` for an exact substring with surrounding context, or `page` to read linearly (1-indexed). Pass exactly one of query/grep/page; defaults to page 1. Don't answer from a cut-off preview — read the part you need first.",
  inputSchema: {
    type: 'object',
    required: ['handle'],
    properties: {
      handle: {
        type: 'string',
        description: "The tr_… handle from a spilled result's envelope.",
      },
      query: {
        type: 'string',
        description: 'Semantic search within the result — returns the most relevant passages.',
      },
      grep: {
        type: 'string',
        description: 'Exact (case-insensitive) substring to locate; returns matches with context.',
      },
      page: {
        type: 'integer',
        description: 'Linear page to read, 1-indexed (used when neither query nor grep is given).',
      },
    },
  },
  handler: async (input, ctx) => {
    const handle = str(input.handle).trim();
    if (!handle) return { ok: false, error: 'handle is required' };

    const query = str(input.query).trim();
    if (query) {
      const r = await queryResult(ctx.ownerId, handle, query);
      ctx.step?.setMeta({ mode: 'query', handle, hits: r.ok ? r.hits.length : 0 });
      return r.ok ? { ok: true, output: { mode: 'query', handle, hits: r.hits } } : r;
    }

    const grep = str(input.grep).trim();
    if (grep) {
      const r = await grepResult(ctx.ownerId, handle, grep);
      ctx.step?.setMeta({ mode: 'grep', handle, count: r.ok ? r.count : 0 });
      return r.ok
        ? { ok: true, output: { mode: 'grep', handle, count: r.count, matches: r.matches } }
        : r;
    }

    const page = typeof input.page === 'number' && Number.isFinite(input.page) ? input.page : 1;
    const r = await readResultPage(ctx.ownerId, handle, page, DEFAULT_RESULT_HANDLING.pageBytes);
    ctx.step?.setMeta({ mode: 'page', handle, page: r.ok ? r.page : undefined });
    return r.ok
      ? {
          ok: true,
          output: {
            mode: 'page',
            handle,
            page: r.page,
            pages: r.pages,
            bytes: r.bytes,
            text: r.text,
          },
        }
      : r;
  },
};

export const TOOL_RESULT_TOOLS: BuiltinToolDef[] = [read_result];
export const TOOL_RESULT_TOOL_SLUGS: readonly string[] = TOOL_RESULT_TOOLS.map((t) => t.slug);

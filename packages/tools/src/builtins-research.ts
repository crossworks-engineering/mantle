/**
 * Research builtins — the OUTWARD-facing half of the brain (Remy's twin).
 * Where recall/search go inward into the user's own archive, this reaches the
 * live internet.
 *
 * `web_search` is the raw search primitive: it asks Perplexity Sonar (via the
 * user's existing OpenRouter key) and returns a cited answer. The smart layer
 * is the `researcher` agent that wraps it — it plans queries, cross-checks,
 * and synthesises. Saskia delegates to `researcher` via `invoke_agent`; the
 * researcher returns a synthesis and Saskia decides whether to persist it as a
 * note (see note_create in builtins-notes.ts).
 */

import { and, eq } from 'drizzle-orm';
import { OpenRouter } from '@openrouter/sdk';
import { apiKeys, db } from '@mantle/db';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The model `web_search` routes through. Any OpenRouter-hosted model that does
 *  live web search works; Perplexity Sonar is the default. Override with
 *  MANTLE_WEB_SEARCH_MODEL (e.g. perplexity/sonar-reasoning for harder queries,
 *  perplexity/sonar-deep-research for exhaustive but slow/expensive runs). */
const WEB_SEARCH_MODEL = process.env.MANTLE_WEB_SEARCH_MODEL || 'perplexity/sonar-pro';

/** An OpenRouter key for this owner — prefers the 'default' label, falls back
 *  to any openrouter key on file. */
async function resolveOpenRouterKey(ownerId: string): Promise<string | null> {
  const k = await getApiKey(ownerId, 'openrouter');
  if (k) return k;
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, ownerId), eq(apiKeys.service, 'openrouter')))
    .limit(1);
  return row ? await getApiKeyById(row.id) : null;
}

/**
 * Pull source URLs out of a Sonar/OpenRouter chat response, defensively —
 * different providers/versions surface citations either as a top-level
 * `citations: string[]` or as per-message `annotations[].url_citation.url`.
 * Pure + exported for unit testing.
 */
export function extractCitations(resp: unknown): string[] {
  const out: string[] = [];
  const r = (resp ?? null) as Record<string, unknown> | null;
  const top = r?.['citations'];
  if (Array.isArray(top)) {
    for (const c of top) {
      if (typeof c === 'string') out.push(c);
      else if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).url === 'string') {
        out.push((c as Record<string, unknown>).url as string);
      }
    }
  }
  const choices = r?.['choices'];
  if (Array.isArray(choices)) {
    const msg = (choices[0] as Record<string, unknown> | undefined)?.['message'] as
      | Record<string, unknown>
      | undefined;
    const ann = msg?.['annotations'];
    if (Array.isArray(ann)) {
      for (const a of ann) {
        const ar = (a ?? {}) as Record<string, unknown>;
        const uc = ar['url_citation'] as Record<string, unknown> | undefined;
        const u = uc?.['url'] ?? ar['url'];
        if (typeof u === 'string') out.push(u);
      }
    }
  }
  return Array.from(new Set(out));
}

const web_search: BuiltinToolDef = {
  slug: 'web_search',
  name: 'Search the web',
  description:
    "Search the live internet and get a synthesised, cited answer (backed by Perplexity Sonar). Pass a focused natural-language query; returns an `answer` plus the `citations` (source URLs) it relied on. Use for anything outside your training data or the user's own stored content: current events, latest docs/prices, how-tos, fact-checking a claim. You can call it several times to triangulate. For the user's OWN past data use search_nodes or recall instead — this only sees the public web.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'focused natural-language search query' },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'optional: bias toward results no older than this window (for time-sensitive queries)',
      },
    },
    required: ['query'],
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim();
    if (!query) return { ok: false, error: 'query is required' };
    const recency = strOpt(input.recency);

    const apiKey = await resolveOpenRouterKey(ctx.ownerId);
    if (!apiKey) {
      return { ok: false, error: 'no openrouter API key configured — add one at /settings/keys' };
    }

    const client = new OpenRouter({
      apiKey,
      httpReferer: 'https://mantle.crossworks.network',
      appTitle: 'Mantle',
    });

    try {
      const chatRequest = {
        model: WEB_SEARCH_MODEL,
        messages: [{ role: 'user', content: query }],
        ...(recency ? { search_recency_filter: recency } : {}),
      };
      // Casts: (1) search_recency_filter is a Perplexity-specific param
      // OpenRouter forwards but the SDK type doesn't model, and messages role
      // widens to string; (2) chat.send returns a response-or-stream union —
      // web_search never streams, so narrow to the non-stream shape we read.
      const resp = (await client.chat.send({
        chatRequest,
      } as unknown as Parameters<typeof client.chat.send>[0])) as unknown as {
        choices?: Array<{ message?: { content?: unknown; annotations?: unknown } }>;
        usage?: unknown;
        citations?: unknown;
      };

      const msg = resp.choices?.[0]?.message;
      const answer = typeof msg?.content === 'string' ? msg.content : '';
      const citations = extractCitations(resp);

      // Cost of the Sonar sub-call isn't rolled into the trace (tool handlers
      // can't add cost yet) — surface usage in step meta for visibility.
      ctx.step?.setMeta({
        model: WEB_SEARCH_MODEL,
        ...(recency ? { recency } : {}),
        citation_count: citations.length,
        usage: resp.usage ?? null,
      });
      ctx.step?.setOutput({ answer_chars: answer.length, citations: citations.length });

      if (!answer) {
        return { ok: false, error: 'web search returned no answer' };
      }
      return { ok: true, output: { query, model: WEB_SEARCH_MODEL, answer, citations } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const RESEARCH_TOOLS: BuiltinToolDef[] = [web_search];

/**
 * Research builtins — the OUTWARD-facing half of the brain (Remy's twin).
 * Where recall/search go inward into the user's own archive, this reaches the
 * live internet.
 *
 * `web_search` (standard) and `web_search_pro` (deep) are the raw search
 * primitives: they ask Perplexity Sonar (via the user's OpenRouter key) and
 * return a cited answer. The MODEL each uses is NOT hardcoded — it comes from a
 * configurable AI Worker (`kind='search'` / `kind='search_advanced'`), set in
 * /settings/ai-workers. Standard runs a cheap/fast Sonar model for everyday
 * lookups; pro runs a stronger/slower one for hard or conflicting questions.
 *
 * The smart layer is the `researcher` agent that wraps these — it plans
 * queries, picks the right tier, cross-checks, and synthesises. Saskia
 * delegates to `researcher` via `invoke_agent`; the researcher returns a
 * synthesis and Saskia decides whether to persist it as a note.
 */

import { and, eq } from 'drizzle-orm';
import { OpenRouter } from '@openrouter/sdk';
import {
  apiKeys,
  db,
  getDefaultWorker,
  bumpWorkerUsage,
  type AiWorker,
  type AiWorkerKind,
  type SearchParams,
} from '@mantle/db';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import { captureLlmUsage } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Last-resort model when NO search worker is configured (fresh brain before the
 *  0087 backfill / onboarding provision runs). The worker is the real source of
 *  truth; this just keeps web_search functional rather than erroring. */
const FALLBACK_SEARCH_MODEL = process.env.MANTLE_WEB_SEARCH_MODEL || 'perplexity/sonar-pro';

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

/** Resolve the search worker for a tier. The advanced tool falls back to the
 *  standard search worker when no advanced one is configured, so deep search
 *  still works on a brain that only set up one tier. */
async function resolveSearchWorker(ownerId: string, kind: AiWorkerKind): Promise<AiWorker | null> {
  const w = await getDefaultWorker(ownerId, kind);
  if (w) return w;
  if (kind === 'search_advanced') return getDefaultWorker(ownerId, 'search');
  return null;
}

/** The key to call OpenRouter with — the worker's own key if it pins one, else
 *  any OpenRouter key on file for the owner. */
async function keyForWorker(ownerId: string, worker: AiWorker | null): Promise<string | null> {
  if (worker?.apiKeyId) {
    const k = await getApiKeyById(worker.apiKeyId);
    if (k) return k;
  }
  return resolveOpenRouterKey(ownerId);
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
      else if (
        c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).url === 'string'
      ) {
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

const SEARCH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string', description: 'focused natural-language search query' },
    recency: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description:
        'optional: bias toward results no older than this window (for time-sensitive queries)',
    },
  },
  required: ['query'],
};

/** Run one Sonar search at the given tier, resolving the model + key from the
 *  configured AI Worker. Shared by both tools. */
async function runWebSearch(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  kind: AiWorkerKind,
): Promise<ToolHandlerResult> {
  const query = str(input.query).trim();
  if (!query) return { ok: false, error: 'query is required' };

  const worker = await resolveSearchWorker(ctx.ownerId, kind);
  const model = worker?.model ?? FALLBACK_SEARCH_MODEL;
  const params = (worker?.params ?? {}) as SearchParams;
  // Per-call recency wins; otherwise the worker's configured default.
  const recency = strOpt(input.recency) ?? params.recency;

  const apiKey = await keyForWorker(ctx.ownerId, worker);
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
      model,
      messages: [{ role: 'user', content: query }],
      // Ask OpenRouter to return real cost accounting so the Sonar spend (incl.
      // per-search surcharge) is attributed accurately.
      usage: { include: true },
      ...(recency ? { search_recency_filter: recency } : {}),
      ...(typeof params.max_tokens === 'number' ? { max_tokens: params.max_tokens } : {}),
    };
    // Casts: (1) search_recency_filter is a Perplexity-specific param OpenRouter
    // forwards but the SDK type doesn't model, and messages role widens to
    // string; (2) chat.send returns a response-or-stream union — web search
    // never streams, so narrow to the non-stream shape we read.
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

    // Attribute the Sonar sub-call's tokens + cost to this step → the active
    // trace, so /debug "spend by agent" reflects research spend.
    if (ctx.step) {
      captureLlmUsage(ctx.step, resp, model);
      ctx.step.setMeta({
        tier: kind,
        ...(recency ? { recency } : {}),
        citation_count: citations.length,
      });
    }
    ctx.step?.setOutput({ answer_chars: answer.length, citations: citations.length });

    if (worker) void bumpWorkerUsage(worker.id);

    if (!answer) {
      return { ok: false, error: 'web search returned no answer' };
    }
    return { ok: true, output: { query, model, answer, citations } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const web_search: BuiltinToolDef = {
  slug: 'web_search',
  name: 'Search the web',
  description:
    "Search the live internet and get a synthesised, cited answer (backed by Perplexity Sonar). Pass a focused natural-language query; returns an `answer` plus the `citations` (source URLs) it relied on. This is the STANDARD, fast/cheap tier — use it for most lookups: current events, latest docs/prices, how-tos, fact-checking a claim. You can call it several times to triangulate. For genuinely hard or conflicting questions use web_search_pro. For the user's OWN past data use search_nodes or recall instead — this only sees the public web.",
  inputSchema: SEARCH_INPUT_SCHEMA,
  handler: (input, ctx) => runWebSearch(input, ctx, 'search'),
};

const web_search_pro: BuiltinToolDef = {
  slug: 'web_search_pro',
  name: 'Deep web search',
  description:
    'Like web_search but uses a STRONGER, SLOWER model — reserve it for hard, ambiguous, or high-stakes questions, or when standard web_search results conflict or are thin. It costs more and takes noticeably longer, so prefer web_search for routine lookups and reach for this only when the question warrants the extra depth.',
  inputSchema: SEARCH_INPUT_SCHEMA,
  handler: (input, ctx) => runWebSearch(input, ctx, 'search_advanced'),
};

export const RESEARCH_TOOLS: BuiltinToolDef[] = [web_search, web_search_pro];

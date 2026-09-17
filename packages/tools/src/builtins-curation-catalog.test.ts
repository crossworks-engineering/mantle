/**
 * Behavioural tests for the curation READ tools: openrouter_rankings,
 * openrouter_benchmarks, openrouter_task_classes, model_catalog and
 * model_pool_list. builtins-curation.test.ts covers the voice supplement as
 * a pure function and builtins-curation-write.test.ts covers model_pool_set;
 * nothing exercised these handlers.
 *
 * The four OpenRouter tools share one shape, and it is the shape that
 * matters: they are evidence-gathering calls against a rate-limited public
 * API, run from a scheduled curation pass, so
 *
 *  - a provider failure (HTTP error or a dead network) must come back as a
 *    tool error the model can read, never a throw that kills the turn;
 *  - the three Data API tools refuse on the team surfaces and refuse without
 *    an OpenRouter key BEFORE any request leaves, so a misgranted tool cannot
 *    spend the owner's daily quota;
 *  - the request itself is pinned (path, query, bearer) because the wrong
 *    window or a missing key is a silent wrong answer, not an error.
 *
 * model_catalog is keyless and cached at module level for a few minutes, so
 * its outage test runs FIRST and the later tests share one loaded catalog.
 * model_pool_list is a plain owner-scoped read; its where clause is walked
 * for the owner id. The network is stubbed at `fetch`, the key lookup at
 * ./builtins-research, the pool table at the db select chain.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('./builtins-research', () => ({ resolveOpenRouterKey: vi.fn() }));

import * as dbmod from '@mantle/db';
import { MODEL_POOLS } from '@mantle/client-types/model-pools';
import { resolveOpenRouterKey } from './builtins-research';
import { CURATION_TOOLS } from './builtins-curation';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const tool = (slug: string) => CURATION_TOOLS.find((t) => t.slug === slug)!;
const catalog = tool('model_catalog');
const rankings = tool('openrouter_rankings');
const benchmarks = tool('openrouter_benchmarks');
const taskClasses = tool('openrouter_task_classes');
const poolList = tool('model_pool_list');

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const teamCtx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

/** One stubbed OpenRouter response for every call. */
function providerReplies(json: unknown, status = 200, text = ''): void {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text,
  })) as unknown as typeof fetch;
}

function providerDown(): void {
  global.fetch = vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

/** The first request: parsed URL and the headers it carried. */
function request(): { url: URL; headers: Record<string, string> } {
  const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
  return {
    url: new URL(String(url)),
    headers: ((init as RequestInit)?.headers ?? {}) as Record<string, string>,
  };
}

const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5',
      name: 'Claude Sonnet 5',
      pricing: { prompt: '0.000003', completion: '0.000015' },
      context_length: 200000,
      architecture: {
        modality: 'text+image->text',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'openai/gpt-image-1',
      name: 'GPT Image 1',
      pricing: { prompt: '0.00001', completion: '0.00004' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    },
    { name: 'no id, dropped' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  providerReplies(CATALOG);
  vi.mocked(resolveOpenRouterKey).mockResolvedValue('k1');
});

describe('model_catalog', () => {
  it('a provider outage or error status is a tool error, not a throw', async () => {
    // Runs before any successful load so nothing is cached yet.
    providerDown();
    expect(errorOf(await catalog.handler({}, ctx))).toMatch(/ECONNREFUSED/);
    providerReplies({}, 503, 'upstream unavailable');
    expect(errorOf(await catalog.handler({}, ctx))).toMatch(
      /OpenRouter \/models returned 503: upstream unavailable/,
    );
  });

  it('refuses on the team surfaces before fetching', async () => {
    expect(errorOf(await catalog.handler({}, teamCtx))).toMatch(/owner-side tool/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('loads keyless, converts pricing to per-million, and appends the voice supplement', async () => {
    const out = outputOf(await catalog.handler({}, ctx));
    const { url, headers } = request();
    expect(url.pathname).toBe('/api/v1/models');
    expect(headers.Authorization).toBeUndefined();

    const models = out.models as Array<Record<string, unknown>>;
    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    expect(sonnet).toMatchObject({
      provider: 'openrouter',
      contextTokens: 200000,
      modality: 'text+image->text',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    });
    expect(sonnet.inputPerM as number).toBeCloseTo(3);
    expect(sonnet.outputPerM as number).toBeCloseTo(15);
    expect(models.some((m) => m.name === 'no id, dropped')).toBe(false);
    // The voice rows OpenRouter omits ride along, priced null on purpose.
    expect(out.total as number).toBeGreaterThan(2);
    const all = outputOf(await catalog.handler({ limit: 100 }, ctx)).models as Array<
      Record<string, unknown>
    >;
    const voice = all.find((m) => m.kind === 'tts')!;
    expect(voice).toBeDefined();
    expect(voice.inputPerM).toBeNull();
  });

  it('serves later calls from the cache', async () => {
    outputOf(await catalog.handler({}, ctx));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('filters by q on slug or name (case-insensitive), by exact ids, and honours limit', async () => {
    const byQ = outputOf(await catalog.handler({ q: 'SONNET' }, ctx));
    expect(byQ.total).toBe(1);
    expect((byQ.models as Array<{ id: string }>)[0]!.id).toBe('anthropic/claude-sonnet-5');

    const byIds = outputOf(
      await catalog.handler({ ids: ['openai/gpt-image-1', 42], q: 'ignored' }, ctx),
    );
    expect((byIds.models as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'openai/gpt-image-1',
    ]);

    const limited = outputOf(await catalog.handler({ limit: 1 }, ctx));
    expect((limited.models as unknown[]).length).toBe(1);
    expect(limited.total as number).toBeGreaterThan(1);
  });
});

describe('openrouter_rankings', () => {
  it('refuses on the team surfaces before the key lookup or any request', async () => {
    expect(errorOf(await rankings.handler({}, teamCtx))).toMatch(/owner-side tool/);
    expect(resolveOpenRouterKey).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('needs an OpenRouter key and sends nothing without one', async () => {
    vi.mocked(resolveOpenRouterKey).mockResolvedValue(null);
    expect(errorOf(await rankings.handler({}, ctx))).toMatch(/no openrouter API key configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a provider failure is a tool error, not a throw', async () => {
    providerReplies({}, 429, 'rate limited');
    expect(errorOf(await rankings.handler({}, ctx))).toMatch(
      /OpenRouter \/datasets\/rankings-daily returned 429: rate limited/,
    );
    providerDown();
    expect(errorOf(await rankings.handler({}, ctx))).toMatch(/ECONNREFUSED/);
  });

  it('aggregates tokens per model over the window, drops "other", busiest first, with attribution', async () => {
    providerReplies({
      data: [
        { model_permaslug: 'a', total_tokens: '5' },
        { model_permaslug: 'b', total_tokens: 10 },
        { model_permaslug: 'a', total_tokens: 7 },
        { model_permaslug: 'other', total_tokens: 99 },
        { total_tokens: 1 },
      ],
      meta: { as_of: '2026-09-01' },
    });
    const out = outputOf(await rankings.handler({ days: 7, category: 'programming' }, ctx));
    expect(out.models).toEqual([
      { model: 'a', tokens: 12 },
      { model: 'b', tokens: 10 },
    ]);
    expect(out.asOf).toBe('2026-09-01');
    expect(out.attribution).toBe('Source: OpenRouter (openrouter.ai/rankings), as of 2026-09-01.');

    const { url, headers } = request();
    expect(url.pathname).toBe('/api/v1/datasets/rankings-daily');
    expect(headers.Authorization).toBe('Bearer k1');
    expect(url.searchParams.get('category')).toBe('programming');
    expect(url.searchParams.has('modality')).toBe(false);
    const window = out.window as { start: string; end: string };
    expect(url.searchParams.get('start_date')).toBe(window.start);
    expect(url.searchParams.get('end_date')).toBe(window.end);
    // A 7-day window ends yesterday and spans 6 days back from there.
    const span = (Date.parse(window.end) - Date.parse(window.start)) / 86_400_000;
    expect(span).toBe(6);
  });

  it('caps the list at limit', async () => {
    providerReplies({
      data: [
        { model_permaslug: 'a', total_tokens: 1 },
        { model_permaslug: 'b', total_tokens: 2 },
      ],
    });
    const out = outputOf(await rankings.handler({ limit: 1 }, ctx));
    expect(out.models).toEqual([{ model: 'b', tokens: 2 }]);
  });
});

describe('openrouter_benchmarks', () => {
  it('refuses on the team surfaces and without a key, sending nothing', async () => {
    expect(errorOf(await benchmarks.handler({}, teamCtx))).toMatch(/owner-side tool/);
    vi.mocked(resolveOpenRouterKey).mockResolvedValue(null);
    expect(errorOf(await benchmarks.handler({}, ctx))).toMatch(/no openrouter API key/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a provider failure is a tool error, not a throw', async () => {
    providerReplies({}, 500, 'boom');
    expect(errorOf(await benchmarks.handler({}, ctx))).toMatch(/\/benchmarks returned 500: boom/);
    providerDown();
    expect(errorOf(await benchmarks.handler({}, ctx))).toMatch(/ECONNREFUSED/);
  });

  it('passes source, task_type and max_results through, and caps the rows', async () => {
    providerReplies({ data: [{ m: 1 }, { m: 2 }, { m: 3 }] });
    const out = outputOf(
      await benchmarks.handler(
        { source: 'design-arena', task_type: 'coding', max_results: 2 },
        ctx,
      ),
    );
    expect(out).toEqual({ count: 2, rows: [{ m: 1 }, { m: 2 }] });
    const { url, headers } = request();
    expect(url.pathname).toBe('/api/v1/benchmarks');
    expect(headers.Authorization).toBe('Bearer k1');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: 'design-arena',
      task_type: 'coding',
      max_results: '2',
    });
  });
});

describe('openrouter_task_classes', () => {
  it('refuses on the team surfaces and without a key, sending nothing', async () => {
    expect(errorOf(await taskClasses.handler({}, teamCtx))).toMatch(/owner-side tool/);
    vi.mocked(resolveOpenRouterKey).mockResolvedValue(null);
    expect(errorOf(await taskClasses.handler({}, ctx))).toMatch(/no openrouter API key/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a provider failure is a tool error, not a throw', async () => {
    providerReplies({}, 502, 'bad gateway');
    expect(errorOf(await taskClasses.handler({}, ctx))).toMatch(
      /\/classifications\/task returned 502/,
    );
    providerDown();
    expect(errorOf(await taskClasses.handler({}, ctx))).toMatch(/ECONNREFUSED/);
  });

  it('asks for the 7-day window with the owner key and passes the body through', async () => {
    providerReplies({ classifications: [{ task: 'code', top: ['a'] }] });
    expect(outputOf(await taskClasses.handler({}, ctx))).toEqual({
      classifications: [{ task: 'code', top: ['a'] }],
    });
    const { url, headers } = request();
    expect(url.pathname).toBe('/api/v1/classifications/task');
    expect(url.searchParams.get('window')).toBe('7d');
    expect(headers.Authorization).toBe('Bearer k1');
  });
});

describe('model_pool_list', () => {
  const ENTRY = {
    id: 'cm1',
    ownerId: 'o1',
    pool: 'agents',
    name: 'Sonnet',
    vendor: 'Anthropic',
    routes: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }],
    pricing: { inputPerM: 3, outputPerM: 15 },
    rating: 5,
    note: 'default',
    position: 0,
  };

  it('rejects an unknown pool without a query', async () => {
    expect(errorOf(await poolList.handler({ pool: 'nope' }, ctx))).toMatch(
      /unknown pool 'nope' — valid pools: agents/,
    );
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('lists every pool, reading entries for the caller owner only, without leaking row ids', async () => {
    selectQueue.push([ENTRY]);
    const out = outputOf(await poolList.handler({}, ctx));
    expect(paramsOf(whereArgs[0])).toEqual(['o1']);
    expect((out.pools as unknown[]).length).toBe(MODEL_POOLS.length);
    expect(out.entries).toEqual([
      {
        pool: 'agents',
        name: 'Sonnet',
        vendor: 'Anthropic',
        routes: ENTRY.routes,
        pricing: ENTRY.pricing,
        rating: 5,
        note: 'default',
        position: 0,
      },
    ]);
  });

  it('narrows one pool in both the where clause and the pool list', async () => {
    selectQueue.push([]);
    const out = outputOf(await poolList.handler({ pool: 'agents' }, ctx));
    expect(paramsOf(whereArgs[0])).toEqual(['o1', 'agents']);
    expect((out.pools as Array<{ id: string }>).map((p) => p.id)).toEqual(['agents']);
    expect(out.entries).toEqual([]);
  });
});

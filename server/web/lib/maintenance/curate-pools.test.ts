import { describe, it, expect } from 'vitest';
import {
  blended,
  combineRank,
  familyKey,
  isAlias,
  planCuration,
  summariseCuration,
  undatedSlug,
  vendorLabel,
  vendorOf,
  type CatalogRow,
} from './curate-pools';

const AT = '2026-09-22T00:00:00.000Z';

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id,
    name: id,
    inputPerM: 1,
    outputPerM: 2,
    contextTokens: 100_000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...over,
  };
}

describe('slug helpers', () => {
  it('strips the dated suffix a permaslug carries, keeping variants', () => {
    expect(undatedSlug('x-ai/grok-4.7-20260916')).toBe('x-ai/grok-4.7');
    expect(undatedSlug('deepseek/deepseek-v4-flash-20260731:free')).toBe(
      'deepseek/deepseek-v4-flash:free',
    );
    // A version that merely looks date-ish must survive — 8 digits is the tell.
    expect(undatedSlug('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });

  it('reads the vendor through an alias tilde', () => {
    expect(vendorOf('~x-ai/grok-latest')).toBe('x-ai');
    expect(vendorLabel('~x-ai/grok-latest')).toBe('xAI');
    // Unknown vendors fall back to the prefix rather than blanking.
    expect(vendorLabel('upstage/solar-pro4')).toBe('upstage');
  });

  it('collapses a version family, and keeps a free tier separate', () => {
    expect(familyKey('x-ai/grok-4.7')).toBe('x-ai/grok');
    expect(familyKey('~x-ai/grok-latest')).toBe('x-ai/grok');
    expect(familyKey('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet');
    expect(familyKey('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    );
    expect(isAlias('~x-ai/grok-latest')).toBe(true);
    expect(isAlias('x-ai/grok-4.7')).toBe(false);
  });
});

describe('blended price', () => {
  it('weights 75/25 input/output, matching model-combos', () => {
    expect(blended(4, 8)).toBe(5);
  });

  it('distinguishes free (0) from unpriced (null)', () => {
    // The distinction the `Free` combo depends on: a per-minute voice route is
    // not a free model, and must never be picked as one.
    expect(blended(0, 0)).toBe(0);
    expect(blended(null, null)).toBeNull();
  });
});

describe('combineRank', () => {
  it('uses the single available signal rather than penalising the missing half', () => {
    // A model with only a benchmark must not rank below one with only usage
    // purely for being unranked — that is how a brand-new flagship gets buried.
    expect(combineRank(0.9, null)).toBe(0.9);
    expect(combineRank(null, 0.9)).toBe(0.9);
  });

  it('lets usage lift a score but never drag it', () => {
    // The benchmark is the floor; usage closes part of the gap to 1. A model
    // is never worse off for having been counted.
    expect(combineRank(0.5, 0)).toBe(0.5);
    expect(combineRank(0.5, 1)).toBeCloseTo(0.7);
    expect(combineRank(0.5, 1)).toBeGreaterThan(combineRank(0.5, null));
    expect(combineRank(0, 0)).toBe(0);
  });
});

describe('planCuration', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('keeps one entry per family, and the alias wins its family slot', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('~x-ai/grok-latest', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('x-ai/grok-4.7', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('x-ai/grok-4.6', { inputPerM: 4, outputPerM: 12 }),
        row('anthropic/claude-sonnet-5', { inputPerM: 2, outputPerM: 10 }),
      ],
      benchmarks: [{ model_permaslug: 'x-ai/grok-4.7-20260916', intelligence_index: 46.4 }],
      usage: [],
      current: [],
    });
    const ids = plan.entries.map((e) => e.routes[0]!.model);
    expect(ids).toContain('~x-ai/grok-latest');
    // Same family, so no pinned Grok rides along beside its own alias.
    expect(ids).not.toContain('x-ai/grok-4.7');
    expect(ids).not.toContain('x-ai/grok-4.6');
    expect(ids).toContain('anthropic/claude-sonnet-5');
  });

  it('orders a priced pool dearest-first and stamps every snapshot', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('a/cheap', { inputPerM: 0.1, outputPerM: 0.2 }),
        row('b/dear', { inputPerM: 10, outputPerM: 50 }),
        row('c/mid', { inputPerM: 2, outputPerM: 4 }),
      ],
      benchmarks: [],
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['b/dear', 'c/mid', 'a/cheap']);
    expect(plan.entries.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(plan.entries[0]!.pricing?.capturedAt).toBe(AT);
  });

  it('sorts unpriced rows last — no price is not free', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('a/unpriced', { inputPerM: null, outputPerM: null }),
        row('b/free', { inputPerM: 0, outputPerM: 0 }),
        row('c/paid', { inputPerM: 5, outputPerM: 5 }),
      ],
      benchmarks: [],
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['c/paid', 'b/free', 'a/unpriced']);
    expect(plan.entries[2]!.pricing).toBeNull();
  });

  it('rejects a model that cannot do the pool job, via poolModelIssue', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        // An image GENERATOR passes every input-side check and belongs nowhere
        // near a text-out pool — the trap poolModelIssue exists for.
        row('g/generator', { outputModalities: ['image', 'text'] }),
        row('t/text'),
      ],
      benchmarks: [],
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['t/text']);
  });

  it('excludes batch queues and the meta-routers', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [row('a/model:batch'), row('openrouter/auto'), row('a/model')],
      benchmarks: [],
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['a/model']);
  });

  it('reports a currently-curated entry the catalog no longer lists', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [row('a/model')],
      benchmarks: [],
      usage: [],
      current: [
        {
          pool: 'agents',
          name: 'Nemotron 3 Ultra',
          routes: [{ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra:free' }],
        },
      ],
    });
    expect(plan.pools[0]!.dropped).toEqual([
      {
        name: 'Nemotron 3 Ultra',
        model: 'nvidia/nemotron-3-ultra:free',
        reason: 'not in the live OpenRouter catalog — a turn on it would 404',
      },
    ]);
    expect(summariseCuration(plan)).toContain('1 currently-curated entry is delisted');
  });

  it('ignores a direct-provider route when judging delisting', () => {
    // OpenRouter's catalog says nothing about `claude-opus-5` on the anthropic
    // route, so absence there is not evidence of anything.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [row('a/model')],
      benchmarks: [],
      usage: [],
      current: [
        {
          pool: 'agents',
          name: 'Claude Opus 5',
          routes: [{ provider: 'anthropic', model: 'claude-opus-5' }],
        },
      ],
    });
    expect(plan.pools[0]!.dropped).toEqual([]);
  });

  it('restricts the search tiers to the Sonar family and splits pro from base', () => {
    const searchPools = [
      {
        id: 'search',
        label: 'Web search',
        description: 'x',
        group: 'workers' as const,
        modality: { input: [], output: 'text' as const },
      },
      {
        id: 'search_advanced',
        label: 'Deep web search',
        description: 'x',
        group: 'workers' as const,
        modality: { input: [], output: 'text' as const },
      },
    ];
    const plan = planCuration({
      capturedAt: AT,
      pools: searchPools,
      catalog: [
        row('perplexity/sonar', { inputPerM: 1, outputPerM: 1 }),
        row('perplexity/sonar-pro', { inputPerM: 3, outputPerM: 15 }),
        // A strong general chat model is not a search-native one.
        row('anthropic/claude-sonnet-5', { inputPerM: 2, outputPerM: 10 }),
      ],
      benchmarks: [],
      usage: [],
      current: [],
    });
    const base = plan.pools.find((p) => p.pool === 'search')!;
    const adv = plan.pools.find((p) => p.pool === 'search_advanced')!;
    expect(base.entries.map((e) => e.routes[0]!.model)).toEqual(['perplexity/sonar']);
    expect(adv.entries.map((e) => e.routes[0]!.model)).toEqual(['perplexity/sonar-pro']);
  });
});

describe('pool cost posture', () => {
  const workhorse = [
    {
      id: 'extractor',
      label: 'Extractor',
      description: 'x',
      group: 'workers' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];
  const premium = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];
  const catalog = [
    row('big/flagship', { inputPerM: 10, outputPerM: 50 }),
    row('small/workhorse', { inputPerM: 0.3, outputPerM: 2.5 }),
  ];
  const benchmarks = [
    { model_permaslug: 'big/flagship-20260101', intelligence_index: 55 },
    { model_permaslug: 'small/workhorse-20260101', intelligence_index: 30 },
  ];

  it('refuses a flagship on a workhorse pool, however well it scores', () => {
    // The bug this encodes: agents and the worker pools share one modality
    // contract, so a fit check alone curated the extractor — which reads every
    // ingested document — onto the dearest model in the catalog.
    const plan = planCuration({
      capturedAt: AT,
      pools: workhorse,
      catalog,
      benchmarks,
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['small/workhorse']);
  });

  it('keeps the flagship on the premium pool', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools: premium,
      catalog,
      benchmarks,
      usage: [],
      current: [],
    });
    expect(plan.entries[0]!.routes[0]!.model).toBe('big/flagship');
  });
});

describe('alias evidence', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('an alias inherits its family’s score instead of rating ★1', () => {
    // Benchmarks key on dated permaslugs of concrete releases, so an alias
    // matches nothing by id. Scored on its own it came back with no signal,
    // sorted last and rated ★1 — backwards, since the alias IS that release.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('~x-ai/grok-latest', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('dull/model', { inputPerM: 1.6, outputPerM: 4.8 }),
      ],
      benchmarks: [{ model_permaslug: 'x-ai/grok-4.7-20260916', intelligence_index: 46.4 }],
      usage: [],
      current: [],
    });
    const alias = plan.entries.find((e) => e.routes[0]!.model === '~x-ai/grok-latest')!;
    expect(alias.rating).toBe(5);
    // And the note must not pass inherited evidence off as a direct measurement.
    expect(alias.note).toContain('currently resolves to');
  });
});

describe('shipped defaults', () => {
  const pools = [
    {
      id: 'extractor',
      label: 'Extractor',
      description: 'x',
      group: 'workers' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('forces the manifest default in even when the ranking would omit it', () => {
    // google/gemini-3.5-flash-lite carries no benchmark and no usage row, so it
    // scored zero and lost every slot — leaving the picker offering ten
    // alternatives to a default it did not itself list.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('a/scored', { inputPerM: 0.1, outputPerM: 0.1 }),
        row('google/gemini-3.5-flash-lite', { inputPerM: 0.3, outputPerM: 2.5 }),
      ],
      benchmarks: [{ model_permaslug: 'a/scored-20260101', intelligence_index: 50 }],
      usage: [],
      current: [],
      required: { extractor: ['google/gemini-3.5-flash-lite'] },
    });
    const ids = plan.entries.map((e) => e.routes[0]!.model);
    expect(ids).toContain('google/gemini-3.5-flash-lite');
    const shipped = plan.entries.find(
      (e) => e.routes[0]!.model === 'google/gemini-3.5-flash-lite',
    )!;
    expect(shipped.note).toContain('the shipped default');
    // Rated on the pool's price order, not ★1 — it is unscored, not bad.
    expect(shipped.rating).toBeGreaterThan(1);
  });

  it('ignores a required id the catalog does not list', () => {
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [row('a/model', { inputPerM: 0.1, outputPerM: 0.1 })],
      benchmarks: [],
      usage: [],
      current: [],
      required: { extractor: ['gone/model'] },
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['a/model']);
  });
});

describe('voice pools take engines, not chat models that accept audio', () => {
  const pools = [
    {
      id: 'stt',
      label: 'Transcribe (STT)',
      description: 'x',
      group: 'workers' as const,
      modality: { input: [], output: 'transcription' as const },
    },
  ];

  it('drops a text-out chat model that merely accepts audio', () => {
    // `~google/gemini-pro-latest` ranked top of Transcribe: it takes audio in
    // and answers in text, which is a conversation about a recording rather
    // than a transcript. poolModelIssue fails open here by design, so the
    // stricter rule has to live in curation.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('chat/accepts-audio', {
          inputModalities: ['text', 'audio'],
          outputModalities: ['text'],
        }),
        row('real/engine', { outputModalities: ['transcription'] }),
      ],
      benchmarks: [],
      usage: [],
      current: [],
    });
    expect(plan.entries.map((e) => e.routes[0]!.model)).toEqual(['real/engine']);
  });
});

describe('evidence inheritance is for aliases only', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('an old release does not borrow its successor’s score', () => {
    // The live preview put `openai/gpt-4` at the TOP of the agents pool at
    // $30/$60 per 1M: it shares the `openai/gpt` family with GPT-5.5, inherited
    // its benchmark, tied on rank, and then won the price tie-break because
    // that prefers the dearer of two equals. An alias is the same model as its
    // target; a 2023 release is not its successor.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('openai/gpt-4', { inputPerM: 30, outputPerM: 60 }),
        row('openai/gpt-5.5', { inputPerM: 2.5, outputPerM: 15 }),
      ],
      benchmarks: [{ model_permaslug: 'openai/gpt-5.5-20260423', intelligence_index: 38.4 }],
      usage: [],
      current: [],
    });
    expect(plan.entries[0]!.routes[0]!.model).toBe('openai/gpt-5.5');
    const old = plan.entries.find((e) => e.routes[0]!.model === 'openai/gpt-4');
    // It may still appear (nothing else fits), but never with a borrowed score.
    if (old) expect(old.note).not.toContain('intelligence index');
  });
});

describe('a forced default replaces its own family', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('does not sit the alias beside the pinned release it resolves to', () => {
    // The live preview listed `~x-ai/grok-latest` at position 3 and
    // `x-ai/grok-4.7` at position 2 — the same model twice, because forcing the
    // shipped default in bypassed the one-per-family rule.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('x-ai/grok-4.7', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('~x-ai/grok-latest', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('other/model', { inputPerM: 1, outputPerM: 1 }),
      ],
      benchmarks: [{ model_permaslug: 'x-ai/grok-4.7-20260916', intelligence_index: 46.4 }],
      usage: [],
      current: [],
      required: { agents: ['~x-ai/grok-latest'] },
    });
    const ids = plan.entries.map((e) => e.routes[0]!.model);
    expect(ids).toContain('~x-ai/grok-latest');
    expect(ids).not.toContain('x-ai/grok-4.7');
  });
});

describe('usage is a percentile, not a share of the leader', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('does not penalise a measured model against an unmeasured one', () => {
    // Real counts span orders of magnitude. Dividing by the maximum made a
    // model with a trillion tokens score ~0.06, and the 60/40 blend then put
    // it BELOW an identical model nobody had ranked. Being measured must not
    // cost you: grok carried the pool's top benchmark and rated ★3.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('measured/model', { inputPerM: 1, outputPerM: 1 }),
        row('unmeasured/model', { inputPerM: 1, outputPerM: 1 }),
        row('busiest/model', { inputPerM: 1, outputPerM: 1 }),
      ],
      benchmarks: [
        { model_permaslug: 'measured/model-20260101', intelligence_index: 50 },
        { model_permaslug: 'unmeasured/model-20260101', intelligence_index: 50 },
        { model_permaslug: 'busiest/model-20260101', intelligence_index: 10 },
      ],
      usage: [
        { model: 'busiest/model-20260101', tokens: 17_000_000_000_000 },
        { model: 'measured/model-20260101', tokens: 1_000_000_000_000 },
      ],
      current: [],
    });
    const rating = (id: string) => plan.entries.find((e) => e.routes[0]!.model === id)!.rating ?? 0;
    expect(rating('measured/model')).toBeGreaterThanOrEqual(rating('unmeasured/model'));
  });
});

describe('ordering keeps its promises', () => {
  const workhorse = [
    {
      id: 'extractor',
      label: 'Extractor',
      description: 'x',
      group: 'workers' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('a forced default is ranked, not appended to the end', () => {
    // Forced entries were pushed onto the list after the sort, so the shipped
    // defaults came out LAST and rated ★2 — worst in their own pool, on the
    // strength of nothing but insertion order.
    const plan = planCuration({
      capturedAt: AT,
      pools: workhorse,
      catalog: [
        row('shipped/default', { inputPerM: 0.3, outputPerM: 2.5 }),
        row('weak/model', { inputPerM: 0.3, outputPerM: 2.5 }),
      ],
      benchmarks: [{ model_permaslug: 'shipped/default-20260101', intelligence_index: 50 }],
      usage: [],
      current: [],
      required: { extractor: ['shipped/default'] },
    });
    expect(plan.entries[0]!.routes[0]!.model).toBe('shipped/default');
    expect(plan.entries[0]!.rating).toBe(5);
  });

  it('a free tier does not take position 0 of a workhorse pool', () => {
    // Quality-per-dollar at a price of zero is just quality, so free tiers
    // swept the top of every worker pool. They are rate-limited and carry no
    // vendor SLA — a fallback, not a default.
    const plan = planCuration({
      capturedAt: AT,
      pools: workhorse,
      catalog: [
        row('vendor/free:free', { inputPerM: 0, outputPerM: 0 }),
        row('vendor/paid', { inputPerM: 0.1, outputPerM: 0.2 }),
      ],
      benchmarks: [
        { model_permaslug: 'vendor/free-20260101', intelligence_index: 40 },
        { model_permaslug: 'vendor/paid-20260101', intelligence_index: 40 },
      ],
      usage: [],
      current: [],
    });
    expect(plan.entries[0]!.routes[0]!.model).toBe('vendor/paid');
  });
});

describe('a shipped default leads its pool', () => {
  const pools = [
    {
      id: 'agents',
      label: 'Agents / Responders',
      description: 'x',
      group: 'agents' as const,
      modality: { input: [], output: 'text' as const },
    },
  ];

  it('even when a rival out-ranks it on adoption', () => {
    // Grok 4.7 shipped six days before the first live run, so it had no usage
    // row, while rivals a fraction behind on the benchmark got a lift straight
    // past it — and the pool then told the owner that the model their brain
    // actually runs was the worst option on the list.
    const plan = planCuration({
      capturedAt: AT,
      pools,
      catalog: [
        row('new/default', { inputPerM: 1.6, outputPerM: 4.8 }),
        row('popular/rival', { inputPerM: 1, outputPerM: 1 }),
      ],
      benchmarks: [
        { model_permaslug: 'new/default-20260916', intelligence_index: 46.4 },
        { model_permaslug: 'popular/rival-20260816', intelligence_index: 44.8 },
      ],
      usage: [{ model: 'popular/rival-20260816', tokens: 9_000_000_000_000 }],
      current: [],
      required: { agents: ['new/default'] },
    });
    expect(plan.entries[0]!.routes[0]!.model).toBe('new/default');
    expect(plan.entries[0]!.rating).toBe(5);
  });
});

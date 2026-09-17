import { describe, expect, it } from 'vitest';
import { buildComboDiff, pickForPool, resolveRoute, type PoolEntry } from './model-combos';

const entry = (
  pool: string,
  position: number,
  name: string,
  inP: number | null,
  outP: number | null,
  routes: { provider: string; model: string }[] = [{ provider: 'openrouter', model: name }],
): PoolEntry => ({
  pool,
  position,
  name,
  rating: null,
  note: null,
  routes,
  pricing:
    inP == null && outP == null
      ? null
      : { inputPerM: inP, outputPerM: outP, currency: 'USD', capturedAt: '', source: 't' },
});

const agentsPool = [
  entry('agents', 0, 'flagship', 5, 25),
  entry('agents', 1, 'mid', 2, 10),
  entry('agents', 2, 'budget', 0.3, 1),
  entry('agents', 3, 'free', 0, 0),
];

describe('pickForPool', () => {
  it('best-advanced takes the priciest; cheapest takes the cheapest PAID, never free', () => {
    expect(pickForPool('best-advanced', agentsPool, 'agents')?.name).toBe('flagship');
    expect(pickForPool('cheapest', agentsPool, 'agents')?.name).toBe('budget');
  });
  it('cheapest prefers a well-rated paid model over a cheaper unrated one', () => {
    const pool = [
      { ...entry('agents', 0, 'rated-cheap', 0.5, 1), rating: 4 },
      entry('agents', 1, 'unrated-cheaper', 0.1, 0.2),
      entry('agents', 2, 'free', 0, 0),
    ];
    expect(pickForPool('cheapest', pool, 'agents')?.name).toBe('rated-cheap');
  });
  it('free picks only a $0 model, and yields null when the pool has none', () => {
    expect(pickForPool('free', agentsPool, 'agents')?.name).toBe('free');
    const noFree = [entry('agents', 0, 'paid', 1, 2)];
    expect(pickForPool('free', noFree, 'agents')).toBeNull();
  });
  it('cost-aware agents = median priced; workers = cheapest PAID (never free)', () => {
    expect(pickForPool('cost-aware', agentsPool, 'agents')?.name).toBe('mid');
    const workerPool = [
      entry('summarizer', 0, 'pricey', 1, 3),
      entry('summarizer', 1, 'cheap-paid', 0.02, 0.03),
      entry('summarizer', 2, 'free', 0, 0),
    ];
    expect(pickForPool('cost-aware', workerPool, 'summarizer')?.name).toBe('cheap-paid');
  });
  it('unpriced pools (voice) use curator order: best-advanced=first, cheapest=last', () => {
    const tts = [
      entry('tts', 0, 'best-fit', null, null),
      entry('tts', 1, 'budget-fit', null, null),
    ];
    expect(pickForPool('best-advanced', tts, 'tts')?.name).toBe('best-fit');
    expect(pickForPool('cheapest', tts, 'tts')?.name).toBe('budget-fit');
    expect(pickForPool('cost-aware', [], 'tts')).toBeNull();
  });
});

describe('resolveRoute', () => {
  const routes = [
    { provider: 'openrouter', model: 'vendor/m' },
    { provider: 'anthropic', model: 'm' },
  ];
  it('prefers keeping the current provider when a key exists', () => {
    const keys = new Map([
      ['openrouter', 'k1'],
      ['anthropic', 'k2'],
    ]);
    expect(resolveRoute(routes, keys, 'anthropic')).toEqual({
      provider: 'anthropic',
      model: 'm',
      apiKeyId: 'k2',
    });
  });
  it('falls back to openrouter, and returns null with no usable key', () => {
    expect(resolveRoute(routes, new Map([['openrouter', 'k1']]), 'google')?.provider).toBe(
      'openrouter',
    );
    expect(resolveRoute(routes, new Map(), 'google')).toBeNull();
  });
});

describe('buildComboDiff', () => {
  const keys = new Map([['openrouter', 'k1']]);
  const targets = [
    {
      id: 'a1',
      kind: 'agent' as const,
      label: 'Saskia',
      pool: 'agents',
      provider: 'openrouter',
      model: 'mid',
    },
    {
      id: 'w1',
      kind: 'worker' as const,
      label: 'Summarizer',
      pool: 'summarizer',
      provider: 'openrouter',
      model: 'x',
    },
  ];
  it('marks changed rows, leaves same-model rows unchanged, reports empty pools', () => {
    const diff = buildComboDiff('best-advanced', agentsPool, targets, keys);
    const agent = diff.find((t) => t.id === 'agent:a1')!;
    expect(agent.changed).toBe(true);
    expect(agent.next?.model).toBe('flagship');
    const worker = diff.find((t) => t.id === 'worker:w1')!;
    expect(worker.next).toBeNull();
    expect(worker.reason).toContain('empty');
    const same = buildComboDiff('cost-aware', agentsPool, [targets[0]!], keys)[0]!;
    expect(same.changed).toBe(false);
  });
});

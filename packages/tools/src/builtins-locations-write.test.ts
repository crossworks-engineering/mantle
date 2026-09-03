/**
 * Behavioural tests for location_save: the write half of the geo loop
 * (nearby → geocode → save). route_map has its own file; this one did not.
 *
 * The property worth pinning is the coordinate guard. `location_nearby`
 * later does haversine on whatever was stored, so a string "12.3" or a NaN
 * that slipped through would poison every distance answer near it. The
 * guard must refuse anything that is not a finite NUMBER, before the store
 * is touched, and the success arm must show the numbers reaching the store
 * as numbers, under the owner, with the ingest recorded against the new node.
 *
 * The store and trace sink are stubbed; the guard and coercion are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, createLocation: vi.fn() };
});
vi.mock('@mantle/api-keys', () => ({ getApiKey: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { createLocation } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { LOCATION_TOOLS } from './builtins-locations';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';

const save = LOCATION_TOOLS.find((t) => t.slug === 'location_save')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const row = {
  id: ID,
  title: 'the office',
  address: '1 Long St, Cape Town',
  latitude: -33.9249,
  longitude: 18.4241,
  source: 'mapbox',
  tags: ['work'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createLocation).mockResolvedValue(row as never);
  vi.mocked(recordIngest).mockResolvedValue(undefined as never);
});

describe('location_save', () => {
  it('refuses non-numeric or non-finite coordinates WITHOUT touching the store', async () => {
    // A numeric string is the realistic failure: models emit "18.4241".
    expect(errorOf(await save.handler({ latitude: '-33.9', longitude: 18.4 }, ctx))).toMatch(
      /finite numbers/,
    );
    expect(errorOf(await save.handler({ latitude: -33.9, longitude: NaN }, ctx))).toMatch(
      /finite numbers/,
    );
    expect(errorOf(await save.handler({ latitude: -33.9 }, ctx))).toMatch(/finite numbers/);
    expect(createLocation).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('stores the place under the owner and records the ingest against the new node', async () => {
    const res = await save.handler(
      {
        latitude: -33.9249,
        longitude: 18.4241,
        address: ' 1 Long St, Cape Town ',
        title: 'the office',
        source: 'mapbox',
        tags: ['work', 1],
      },
      ctx,
    );

    expect(createLocation).toHaveBeenCalledWith('o1', {
      latitude: -33.9249,
      longitude: 18.4241,
      address: '1 Long St, Cape Town',
      title: 'the office',
      source: 'mapbox',
      body: undefined,
      tags: ['work'],
    });
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        nodeId: ID,
        source: 'agent_tool',
        payload: expect.objectContaining({ provider: 'mapbox' }),
      }),
    );
    expect(outputOf(res)).toMatchObject({ id: ID, title: 'the office' });
  });

  it('surfaces a store failure and records no ingest for a node that never existed', async () => {
    vi.mocked(createLocation).mockRejectedValue(new Error('latitude out of range'));

    expect(errorOf(await save.handler({ latitude: 95, longitude: 0 }, ctx))).toMatch(
      /out of range/,
    );
    expect(recordIngest).not.toHaveBeenCalled();
  });
});

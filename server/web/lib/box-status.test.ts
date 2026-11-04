/**
 * The Status view's containers part (lib/box-status.ts containersView): the
 * updater's services.json as read, nothing added; null all round where the
 * brain has no file. The route itself is GET /api/box-status.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseServicesFile } from '@mantle/config';
import type { BoxStatus } from '@mantle/tools';
import {
  BOX_STATUS_FAIL_TTL_MS,
  BOX_STATUS_TTL_MS,
  containersView,
  makeBoxStatusCache,
} from './box-status';

describe('containersView', () => {
  it('passes the parsed containers through with the check time and the shape', () => {
    const file = parseServicesFile(
      JSON.stringify({
        profiles: 'documents',
        core: true,
        checked_at: '2026-11-04T06:00:00Z',
        containers: {
          gotenberg: {
            container: 'running',
            health: 'healthy',
            restarts: 0,
            started_at: '2026-11-04T05:00:00Z',
          },
          worker_runs: { container: 'absent', health: 'none', restarts: 0, started_at: '' },
        },
      }),
    );
    expect(containersView(file)).toEqual({
      containers: {
        gotenberg: {
          container: 'running',
          health: 'healthy',
          restarts: 0,
          startedAt: '2026-11-04T05:00:00Z',
        },
        worker_runs: { container: 'absent', health: 'none', restarts: 0, startedAt: null },
      },
      containersCheckedAt: '2026-11-04T06:00:00Z',
      core: true,
    });
  });

  it('an updater before the field: no containers, the rest still known', () => {
    const file = parseServicesFile(
      '{"profiles":"","core":false,"checked_at":"2026-11-04T06:00:00Z"}',
    );
    expect(containersView(file)).toEqual({
      containers: null,
      containersCheckedAt: '2026-11-04T06:00:00Z',
      core: false,
    });
  });

  it('no file at all: nothing known', () => {
    expect(containersView(null)).toEqual({
      containers: null,
      containersCheckedAt: null,
      core: null,
    });
  });
});

describe('the box status cache', () => {
  const status = { schema: 1 } as BoxStatus;

  it('serves one collection for the TTL', async () => {
    let t = 0;
    const collect = vi.fn(async () => status);
    const get = makeBoxStatusCache(collect, () => t);
    await get('o');
    t += BOX_STATUS_TTL_MS - 1;
    await get('o');
    expect(collect).toHaveBeenCalledTimes(1);
    t += 2;
    await get('o');
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed collection for a few seconds, then tries again', async () => {
    let t = 0;
    const collect = vi.fn(async (): Promise<BoxStatus> => {
      throw new Error('down');
    });
    const get = makeBoxStatusCache(collect, () => t);
    await expect(get('o')).rejects.toThrow('down');
    t += BOX_STATUS_FAIL_TTL_MS - 1;
    await expect(get('o')).rejects.toThrow('down');
    expect(collect).toHaveBeenCalledTimes(1);
    t += 2;
    await expect(get('o')).rejects.toThrow('down');
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

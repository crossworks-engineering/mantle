/**
 * The Status view's containers part (lib/box-status.ts containersView): the
 * updater's services.json as read, nothing added; null all round where the
 * brain has no file. The route itself is GET /api/box-status.
 */
import { describe, expect, it } from 'vitest';
import { parseServicesFile } from '@mantle/config';
import { containersView } from './box-status';

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

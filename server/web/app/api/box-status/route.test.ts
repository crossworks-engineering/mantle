/**
 * GET /api/box-status without a database: the owner is stood in, the
 * collection and the updater's file are fakes carrying extra keys (a host
 * name, a title, an unlisted container). The answer has the four keys of
 * BoxStatusView and nothing else at the top, the status is held to schema
 * 1, and no extra key or value gets through anywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseServicesFile } from '@mantle/config';
import type { BoxStatus } from '@mantle/tools';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id' }),
}));

const STATUS = {
  schema: 1,
  ts: '2026-11-04T06:00:00.000Z',
  hostname: 'secret-box.example.invalid',
  build: { version: '0.500.19', gitSha: 'abcdef1', buildTime: null, branch: 'leak' },
  process: { uptimeSec: 1, heapUsedBytes: 1, rssBytes: 1 },
  host: { scope: 'host', cpuLoadPct: 1, loadAvg: [1, 1, 1], cores: 2, mem: null, disk: null },
  postgres: { up: true, dbSizeBytes: 1, connections: 1, cacheHitPct: 1, user: 'leak' },
  services: {
    objectStore: true,
    parser: { up: true, running: 0, queued: 0 },
    browser: true,
    documents: true,
    embedder: null,
    sandboxes: null,
    network: null,
  },
  spend: null,
  capacity: null,
  extraction: null,
  logins: null,
  degraded: ['postgres', 'a title someone wrote'],
} as unknown as BoxStatus;

vi.mock('@/lib/box-status', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/box-status')>();
  return {
    ...real,
    boxStatusView: (ownerId: string) =>
      real.boxStatusView(ownerId, {
        status: async () => STATUS,
        file: () =>
          parseServicesFile(
            JSON.stringify({
              profiles: '',
              core: false,
              checked_at: '2026-11-04T06:00:00Z',
              site: 'secret-box.example.invalid',
              containers: {
                postgres: { container: 'running', health: 'healthy', restarts: 0, started_at: '' },
                'secret-box.example.invalid': { container: 'running' },
              },
            }),
          ),
      }),
  };
});

describe('GET /api/box-status', () => {
  it('answers the four keys only, and nothing extra anywhere', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['box', 'containers', 'containersCheckedAt', 'core']);
    expect(body.containers).toEqual({
      postgres: { container: 'running', health: 'healthy', restarts: 0, startedAt: null },
    });
    expect(body.containersCheckedAt).toBe('2026-11-04T06:00:00Z');
    expect(body.core).toBe(false);
    const box = body.box as Record<string, unknown>;
    expect(box.degraded).toEqual(['postgres']);
    const text = JSON.stringify(body);
    expect(text).not.toContain('secret-box');
    expect(text).not.toContain('leak');
    expect(text).not.toContain('hostname');
    expect(text).not.toContain('title');
  });
});

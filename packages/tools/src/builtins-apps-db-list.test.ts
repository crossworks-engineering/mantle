/**
 * `app_db_list` (apps audit 2026-10-02): one app whose database file is lost
 * (AppDbMissingError since Phase 0) is that app's line in the answer, not the
 * end of the whole list. Store edges stubbed.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-broker')>();
  return {
    ...actual,
    listAppDatabaseSummaries: vi.fn(async () => [
      { appNodeId: 'a1', title: 'Fine', sizeBytes: 10, updatedAt: '2026-10-02T00:00:00.000Z' },
      { appNodeId: 'a2', title: 'Lost', sizeBytes: 20, updatedAt: '2026-10-02T00:00:00.000Z' },
    ]),
    appDbSchema: vi.fn(async (_owner: string, id: string) => {
      if (id === 'a2') throw new actual.AppDbMissingError(id);
      return [{ name: 't', sql: 'CREATE TABLE t (x)' }];
    }),
  };
});

import { withViewer } from '@mantle/db';
import { APP_DATA_TOOLS } from './builtins-apps';

const list = APP_DATA_TOOLS.find((t) => t.slug === 'app_db_list')!;

describe('app_db_list', () => {
  it('reports a lost app on its own line and lists the rest', async () => {
    const res = await withViewer('admin', () =>
      list.handler({}, { ownerId: 'o1', surface: { kind: 'web' } }),
    );
    if (!res.ok) throw new Error(res.error);
    const { apps } = res.output as { apps: Record<string, unknown>[] };
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ app_id: 'a1', tables: [{ name: 't' }] });
    expect(apps[1]).toMatchObject({ app_id: 'a2', error: expect.stringMatching(/missing/) });
  });
});

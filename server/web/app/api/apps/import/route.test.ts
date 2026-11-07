/**
 * POST /api/apps/import over an app, without a database: a new schema script is
 * declared, and an import with none declares nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const APP = '11111111-2222-4333-8444-555555555555';
const DDL = 'CREATE TABLE IF NOT EXISTS a (x);';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  snapshot: vi.fn(),
  save: vi.fn(),
  declare: vi.fn(),
  build: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id' }),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: async () => ({ id: APP }),
  saveDraftSource: h.save,
  declareAppSchema: h.declare,
  notifyAppNavChanged: async () => {},
}));
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkAppSchemaScript: h.check,
}));
vi.mock('@mantle/content/app-snapshots', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  snapshotBeforeCodeChange: h.snapshot,
}));
vi.mock('@mantle/tools', () => ({
  buildAndStageApp: h.build,
  resolveTool: async () => null,
}));

import { POST } from './route';

const post = (body: Record<string, unknown>) =>
  POST(
    new Request('http://local/api/apps/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: APP,
        entry: 'App.tsx',
        files: { 'App.tsx': 'x' },
        build: false,
        ...body,
      }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ draftUpdatedAt: 'now' });
  h.declare.mockResolvedValue(2);
});

describe('POST /api/apps/import over an app', () => {
  it('a new schema is declared', async () => {
    const res = await post({ schemaSql: DDL });
    expect(res.status).toBe(200);
    expect(h.declare).toHaveBeenCalledWith('owner-id', APP, DDL);
  });

  it('an import with no schema declares nothing', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(h.declare).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalled();
  });
});

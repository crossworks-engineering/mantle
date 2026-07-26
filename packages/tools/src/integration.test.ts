/**
 * Stored-docs round trip: an integration's documentation must land as a real
 * markdown file node under `files/api-docs/<group>.md` — the same pipeline an
 * upload uses, which is what gets it summarised, embedded and searchable — and
 * come back out byte-identical.
 *
 * @mantle/files and @mantle/db are mocked: this asserts the CONTRACT with the
 * file layer (ltree path, filename, overwrite, provenance header, the cap), not
 * the file layer itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertFile = vi.fn();
const createFolder = vi.fn();
const folderByPath = vi.fn();
const readFileById = vi.fn();
const ensureFilesRootBranch = vi.fn();

vi.mock('@mantle/db', () => ({ db: {}, toolGroups: {} }));
vi.mock('@mantle/files', () => ({
  dashToLtree: (s: string) => s.replace(/-/g, '_'),
  createFolder: (...a: unknown[]) => createFolder(...a),
  ensureFilesRootBranch: (...a: unknown[]) => ensureFilesRootBranch(...a),
  folderByPath: (...a: unknown[]) => folderByPath(...a),
  readFileById: (...a: unknown[]) => readFileById(...a),
  upsertFile: (...a: unknown[]) => upsertFile(...a),
}));

const OWNER = 'owner-1';

let mod: typeof import('./integration');

beforeEach(async () => {
  vi.clearAllMocks();
  folderByPath.mockResolvedValue({ id: 'folder-1', path: 'files.api_docs' });
  upsertFile.mockImplementation(async (args: { bytes: Buffer; filename: string }) => ({
    id: 'node-1',
    filename: args.filename,
    sizeBytes: args.bytes.byteLength,
  }));
  mod = await import('./integration');
});

describe('upsertApiDocsFile', () => {
  it('writes files/api-docs/<group>.md through the normal file pipeline', async () => {
    const res = await mod.upsertApiDocsFile({
      ownerId: OWNER,
      groupSlug: 'weather-tools',
      service: 'openweathermap',
      sourceUrl: 'https://openweathermap.org/api',
      markdown: '## GET /weather\n\nReturns current conditions for a city.',
    });
    expect(res.nodeId).toBe('node-1');
    const call = upsertFile.mock.calls[0]?.[0] as {
      ownerId: string;
      parentPath: string;
      filename: string;
      bytes: Buffer;
      overwrite: boolean;
    };
    expect(call.ownerId).toBe(OWNER);
    // ltree labels can't carry a dash — the folder is api_docs, the disk dir api-docs.
    expect(call.parentPath).toBe('files.api_docs');
    expect(mod.API_DOCS_FOLDER_PATH).toBe('files.api_docs');
    expect(call.filename).toBe('weather-tools.md');
    // One file per group: replacing is the point, not accumulating versions.
    expect(call.overwrite).toBe(true);
    const text = call.bytes.toString('utf8');
    expect(text).toContain('# openweathermap API documentation');
    expect(text).toContain('https://openweathermap.org/api');
    expect(text).toContain('## GET /weather');
  });

  it('creates the api-docs folder on first use and reuses it after', async () => {
    folderByPath.mockResolvedValueOnce(null);
    await mod.upsertApiDocsFile({ ownerId: OWNER, groupSlug: 'g', markdown: 'x' });
    expect(ensureFilesRootBranch).toHaveBeenCalledWith(OWNER);
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, parentPath: 'files', slug: 'api-docs' }),
    );
    createFolder.mockClear();
    await mod.upsertApiDocsFile({ ownerId: OWNER, groupSlug: 'g', markdown: 'x' });
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('swallows the concurrent-create race, not real folder failures', async () => {
    folderByPath.mockResolvedValue(null);
    createFolder.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(
      mod.upsertApiDocsFile({ ownerId: OWNER, groupSlug: 'g', markdown: 'x' }),
    ).resolves.toMatchObject({ nodeId: 'node-1' });

    createFolder.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(
      mod.upsertApiDocsFile({ ownerId: OWNER, groupSlug: 'g', markdown: 'x' }),
    ).rejects.toThrow('disk on fire');
  });

  it('clips oversized docs instead of writing an unbounded file', async () => {
    const huge = 'a'.repeat(mod.API_DOCS_MAX_CHARS + 5_000);
    const res = await mod.upsertApiDocsFile({ ownerId: OWNER, groupSlug: 'g', markdown: huge });
    const call = upsertFile.mock.calls[0]?.[0] as { bytes: Buffer };
    const header = mod.apiDocsHeader({ groupSlug: 'g', capturedAt: res.capturedAt });
    expect(call.bytes.toString('utf8').length).toBe(header.length + mod.API_DOCS_MAX_CHARS);
  });
});

describe('readApiDocsFile', () => {
  it('returns the stored text a set call wrote', async () => {
    await mod.upsertApiDocsFile({
      ownerId: OWNER,
      groupSlug: 'weather-tools',
      markdown: '## GET /weather',
    });
    const written = (upsertFile.mock.calls[0]?.[0] as { bytes: Buffer }).bytes;
    readFileById.mockResolvedValue({ bytes: written, row: { filename: 'weather-tools.md' } });
    const back = await mod.readApiDocsFile({ ownerId: OWNER, nodeId: 'node-1' });
    expect(back?.filename).toBe('weather-tools.md');
    expect(back?.text).toBe(written.toString('utf8'));
    expect(back?.text).toContain('## GET /weather');
  });

  it('is null when the owner deleted the file (treated as "no stored docs")', async () => {
    readFileById.mockResolvedValue(null);
    expect(await mod.readApiDocsFile({ ownerId: OWNER, nodeId: 'gone' })).toBeNull();
  });
});

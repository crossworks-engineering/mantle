/**
 * The pipelines list and `pipeline_list`: the rows are the built-ins, the
 * counts come from the folder of file databases and each stamp, numbers
 * only. On a temporary files root with small made-up databases; the file
 * rows (read in the caller's scope) are a stand-in, so no Postgres.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PIPELINES, fileDbPaths, fileDbsDir } from '@mantle/files';
import { writeDocFile } from '@mantle/tabledb/write';
import type { ToolHandlerContext } from './types';

type Row = { id: string; path: string; title: string; data: Record<string, unknown> };
const h = vi.hoisted(() => ({ rows: new Map<string, Row>(), asked: [] as string[][] }));

vi.mock('@mantle/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...real,
    fileDataRows: vi.fn(async (_owner: string, ids: readonly string[]) => {
      h.asked.push([...ids]);
      return ids.flatMap((id) => (h.rows.has(id) ? [h.rows.get(id)!] : []));
    }),
    fileDataRow: vi.fn(async (_owner: string, id: string) => h.rows.get(id) ?? null),
  };
});

const { listPipelines, fileReadBy, pipeline_list, versionBelow } = await import('./pipelines');

const OWNER = '00000000-0000-4000-8000-000000000000';
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const sha = (c: string) => c.repeat(64);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-pipelines-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  h.rows.clear();
  h.asked = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const DOC = {
  columns: [{ id: 'c1', name: 'Tag', type: 'text' as const }],
  rows: [{ id: 'r1', cells: { c1: 'P-101' } }],
};

/** A file row, and its database at these bytes with this stamp (none: a
 *  database built before stamps). */
function file(n: number, filename: string, c: string, stamp?: { id: string; version: string }) {
  h.rows.set(id(n), {
    id: id(n),
    path: 'files',
    title: filename,
    data: { filename, sha256: sha(c) },
  });
  mkdirSync(fileDbsDir(), { recursive: true });
  writeDocFile(fileDbPaths(id(n), sha(c))!.sqlite, DOC, {
    nodeId: id(n),
    ownerId: OWNER,
    ...(stamp
      ? {
          extraMeta: {
            pipeline_id: stamp.id,
            pipeline_version: stamp.version,
            pipeline_api: '1',
            shapes: '',
          },
        }
      : {}),
  });
}

const countsOf = (list: Awaited<ReturnType<typeof listPipelines>>) =>
  Object.fromEntries(list.pipelines.map((p) => [p.id, [p.files, p.older]]));

describe('versionBelow', () => {
  it('compares x.y.z as numbers, and a version that is not one reads as lower', () => {
    expect(versionBelow('1.9.0', '1.10.0')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(versionBelow('1.0.0', '1.0.0')).toBe(false);
    expect(versionBelow('0.9.9', '1.0.0')).toBe(true);
    expect(versionBelow('2.0.0', '1.99.99')).toBe(false);
    expect(versionBelow('one', '1.0.0')).toBe(true);
    expect(versionBelow('1.0.0', 'one')).toBe(false);
  });
});

describe('listPipelines', () => {
  it('lists the built-ins, with zero counts on an empty folder', async () => {
    const list = await listPipelines(OWNER);
    expect(list.api).toBe(1);
    expect(list.countsPartial).toBe(false);
    expect(list.pipelines.map((p) => p.id)).toEqual(BUILTIN_PIPELINES.map((p) => p.id));
    expect(list.pipelines.find((p) => p.id === 'drawing-cad')).toEqual({
      id: 'drawing-cad',
      name: 'CAD drawing',
      version: '1.0.0',
      source: 'builtin',
      start: 'upload',
      reads: ['dwg', 'dxf', 'dgn'],
      weight: 'heavy',
      shapes: ['drawing-v1', 'circuit-v1'],
      workers: [],
      tools: [],
      files: 0,
      older: 0,
    });
  });

  it('counts by the stamp, an unstamped database by its extension, and only names at the bytes of a row it reads', async () => {
    file(1, 'a.csv', 'a', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.xlsx', 'b', { id: 'sheet', version: '0.9.0' });
    file(3, 'c.dwg', 'c');
    // A database of older bytes only: the row now has other bytes.
    file(4, 'd.pdf', 'd', { id: 'drawing-pdf', version: '1.0.0' });
    h.rows.get(id(4))!.data.sha256 = sha('e');
    // A database with no row the caller reads.
    file(5, 'e.csv', 'f', { id: 'sheet', version: '1.0.0' });
    h.rows.delete(id(5));
    // A word only: no database.
    writeFileSync(fileDbPaths(id(6), sha('6'))!.none, 'no-rows\n');
    h.rows.set(id(6), { id: id(6), path: 'files', title: 'f.xml', data: { sha256: sha('6') } });

    const list = await listPipelines(OWNER);
    expect(countsOf(list)).toEqual({
      sheet: [2, 1],
      'plan-mspdi': [0, 0],
      'drawing-pdf': [0, 0],
      'plot-dwf': [0, 0],
      'drawing-cad': [1, 1],
    });
    expect(list.countsPartial).toBe(false);
    // Numbers only: no file name, no id.
    const text = JSON.stringify(list);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(text).not.toContain(id(n));
    for (const name of ['a.csv', 'b.xlsx', 'c.dwg', 'P-101']) expect(text).not.toContain(name);
  });

  it('stops at its cap and says so', async () => {
    file(1, 'a.csv', 'a', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.csv', 'b', { id: 'sheet', version: '1.0.0' });
    file(3, 'c.csv', 'c', { id: 'sheet', version: '1.0.0' });
    const list = await listPipelines(OWNER, { max: 2 });
    expect(list.countsPartial).toBe(true);
    expect(countsOf(list).sheet).toEqual([2, 0]);
    expect(h.asked).toEqual([[id(1), id(2)]]);
  });

  it('gives no counts in a process with no files mount', async () => {
    vi.stubEnv('MANTLE_FILES_ROOT', path.join(root, 'not-there'));
    const list = await listPipelines(OWNER);
    expect(list.pipelines.every((p) => p.files === null && p.older === null)).toBe(true);
    expect(list.countsPartial).toBe(false);
  });
});

describe('pipeline_list', () => {
  it('reads with no input, MCP only, in the settings area, not systemWhole', () => {
    expect(pipeline_list.mcpOnly).toBe(true);
    expect(pipeline_list.policy).toMatchObject({
      effect: 'read',
      spends: 'none',
      scope: { area: 'settings' },
    });
    expect(pipeline_list.policy.scope).toEqual({ area: 'settings' });
    expect(pipeline_list.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('gives the same list as listPipelines', async () => {
    file(1, 'a.csv', 'a', { id: 'sheet', version: '1.0.0' });
    file(3, 'c.dxf', 'c');
    const out = await pipeline_list.handler({}, { ownerId: OWNER } as ToolHandlerContext);
    expect(out).toEqual({ ok: true, output: await listPipelines(OWNER) });
  });
});

describe('fileReadBy', () => {
  it("gives the stamp's pipeline and version, and null before stamps or with no database", async () => {
    file(1, 'a.csv', 'a', { id: 'sheet', version: '1.0.0' });
    file(2, 'b.dwg', 'b');
    expect(await fileReadBy(OWNER, id(1))).toEqual({ pipeline: 'sheet', version: '1.0.0' });
    expect(await fileReadBy(OWNER, id(2))).toBeNull();
    expect(await fileReadBy(OWNER, id(9))).toBeNull();
  });
});

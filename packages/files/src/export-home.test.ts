/**
 * saveExport's names and its clean-up (member export fix round 1, M1). The
 * Files root is one folder for every workspace, so a member's export often
 * meets a name another member's file (or its own last export) holds. It
 * never goes over a file: a taken name takes the next free one, the same
 * whoever holds it; a refusal names only the caller's own filename; a
 * spooled package is removed on every failure; and a landedIn read that
 * fails after the file is made names no workspace instead of failing the
 * export. The database and the file store are stood in.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConflictError } from '@mantle/std';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  taken: new Set<string>(),
  upsert: [] as string[],
  upsertImpl: null as null | ((filename: string) => Promise<unknown>),
  folderThrows: false,
  landedThrows: false,
  allTaken: false,
  /** Whether the caller may change the Files root and its Auto-filed
   *  folder (an Admin-scope caller); a member by default. */
  admin: false,
  sources: [] as string[],
  upsertArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  currentCreateHome: () => null,
  landedIn: async (ids: string[]) => {
    if (h.landedThrows) throw new Error('CONNECTION_CLOSED');
    return ids.map(() => ({ id: 'ws-1', name: 'Home' }));
  },
}));
vi.mock('./ops/shared', () => ({
  ensureFilesRootBranch: async () => {
    if (h.folderThrows) throw new Error('createFolder: parent folder not found');
  },
}));
vi.mock('./auto-filed', () => ({
  AUTO_FILED_PATH: 'files.auto_filed',
  ensureAutoFiledFolder: async (_o: string, source: string) => {
    h.sources.push(source);
    return `files.auto_filed.${source}.2026_11`;
  },
}));
vi.mock('./ops/files', () => ({
  // A member by default: the Files root is not its to change.
  callerMayEditFolder: async () => h.admin,
  fileNameTaken: async (_o: string, _p: string, name: string) =>
    h.allTaken || h.taken.has(name) ? { id: 'x', folded: false, exact: true } : null,
  upsertFile: async (args: { filename: string; parentPath: string }) => {
    h.upsert.push(args.filename);
    h.upsertArgs.push(args as unknown as Record<string, unknown>);
    if (h.upsertImpl) return h.upsertImpl(args.filename);
    return { id: `f-${args.filename}`, filename: args.filename, parentPath: args.parentPath };
  },
}));

const { saveExport, exportFolder, exportNames, EXPORT_NAME_TRIES } = await import('./export-home');

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'export-home-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.taken.clear();
  h.upsert.length = 0;
  h.upsertImpl = null;
  h.folderThrows = false;
  h.landedThrows = false;
  h.allTaken = false;
  h.admin = false;
  h.sources.length = 0;
  h.upsertArgs.length = 0;
});

let spools = 0;
const spool = async () => {
  const tempPath = path.join(dir, `s${++spools}.part`);
  await writeFile(tempPath, 'package');
  return { tempPath, sha256: 'abc', size: 7 };
};
const NEUTRAL = /^export: no free name for 'Q1 Pack\.xlsx' in this folder/;

describe('exportNames', () => {
  it('the name as upsertFile cleans it, then -2 on, then a time stamp', () => {
    const names = exportNames('Q1 Pack.xlsx');
    expect(names[0]).toBe('q1-pack.xlsx');
    expect(names[1]).toBe('q1-pack-2.xlsx');
    expect(names[EXPORT_NAME_TRIES - 1]).toBe(`q1-pack-${EXPORT_NAME_TRIES}.xlsx`);
    expect(names).toHaveLength(EXPORT_NAME_TRIES + 1);
    expect(names.at(-1)).toMatch(/^q1-pack-[0-9a-z]+\.xlsx$/);
    expect(new Set(names).size).toBe(names.length);
    expect(exportNames('notes')[1]).toBe('notes-2');
  });
});

describe('saveExport', () => {
  it('a free name is used as is, at the Files root, and names where it landed', async () => {
    const out = await saveExport({
      ownerId: 'o',
      filename: 'Q1 Pack.xlsx',
      bytes: Buffer.from('x'),
    });
    expect(h.upsert).toEqual(['q1-pack.xlsx']);
    expect(out.file.parentPath).toBe('files');
    expect(out.autoFiled).toBe(false);
    expect(out.landedIn).toEqual({ id: 'ws-1', name: 'Home' });
  });

  it('a taken name, whoever holds it, takes the next free one and never reaches upsertFile', async () => {
    h.taken.add('q1-pack.xlsx').add('q1-pack-2.xlsx');
    const out = await saveExport({
      ownerId: 'o',
      filename: 'Q1 Pack.xlsx',
      bytes: Buffer.from('x'),
    });
    expect(h.upsert).toEqual(['q1-pack-3.xlsx']);
    expect(out.file.filename).toBe('q1-pack-3.xlsx');
  });

  it('a create that takes the name in between: the next name', async () => {
    h.upsertImpl = async (name) => {
      if (name === 'q1-pack.xlsx') throw new ConflictError(`writeFile: '${name}' already exists`);
      return { id: 'f', filename: name, parentPath: 'files' };
    };
    const out = await saveExport({
      ownerId: 'o',
      filename: 'Q1 Pack.xlsx',
      bytes: Buffer.from('x'),
    });
    expect(h.upsert).toEqual(['q1-pack.xlsx', 'q1-pack-2.xlsx']);
    expect(out.file.filename).toBe('q1-pack-2.xlsx');
  });

  it('a spooled package retries while its bytes are there', async () => {
    const s = await spool();
    h.upsertImpl = async (name) => {
      if (name === 'q1-pack.xlsx') throw new ConflictError('taken');
      return { id: 'f', filename: name, parentPath: 'files' };
    };
    const out = await saveExport({ ownerId: 'o', filename: 'Q1 Pack.xlsx', spooled: s });
    expect(out.file.filename).toBe('q1-pack-2.xlsx');
  });

  it('every name taken: the neutral refusal, nothing written, the spool removed', async () => {
    // Every name, the time-stamped one too (made when the call runs).
    h.allTaken = true;
    const s = await spool();
    const err = await saveExport({ ownerId: 'o', filename: 'Q1 Pack.xlsx', spooled: s }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(NEUTRAL);
    expect((err as Error).message).not.toMatch(/already exists/);
    expect(h.upsert).toEqual([]);
    expect(existsSync(s.tempPath)).toBe(false);
  });

  it('a lost race after the spool was staged: its own words, no retry', async () => {
    const s = await spool();
    h.upsertImpl = async (name) => {
      await rm(s.tempPath, { force: true });
      throw new ConflictError(`writeFile: '${name}' already exists in this folder`);
    };
    const err = await saveExport({ ownerId: 'o', filename: 'Q1 Pack.xlsx', spooled: s }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe('export: the name was taken while saving; try again');
    expect(h.upsert).toEqual(['q1-pack.xlsx']);
  });

  it('any other failure removes the spool: the folder, or the write', async () => {
    h.folderThrows = true;
    const s1 = await spool();
    await expect(saveExport({ ownerId: 'o', filename: 'a.xlsx', spooled: s1 })).rejects.toThrow(
      /parent folder/,
    );
    expect(existsSync(s1.tempPath)).toBe(false);

    h.folderThrows = false;
    h.taken.add('a.xlsx');
    h.upsertImpl = async () => {
      throw new Error('disk full');
    };
    const s2 = await spool();
    await expect(saveExport({ ownerId: 'o', filename: 'a.xlsx', spooled: s2 })).rejects.toThrow(
      'disk full',
    );
    expect(existsSync(s2.tempPath)).toBe(false);
  });

  it('a landedIn read that fails after the file is made: the file, landedIn null', async () => {
    h.landedThrows = true;
    const out = await saveExport({ ownerId: 'o', filename: 'a.xlsx', bytes: Buffer.from('x') });
    expect(out.file.filename).toBe('a.xlsx');
    expect(out.landedIn).toBeNull();
  });
});

describe('the Auto-filed source (screenshots share the export rule)', () => {
  it('an Admin-scope caller files into Exports by default: export behaviour unchanged', async () => {
    h.admin = true;
    expect(await exportFolder('o')).toEqual({
      path: 'files.auto_filed.exports.2026_11',
      autoFiled: true,
    });
    const out = await saveExport({ ownerId: 'o', filename: 'a.xlsx', bytes: Buffer.from('x') });
    expect(h.sources).toEqual(['exports', 'exports']);
    expect(out.file.parentPath).toBe('files.auto_filed.exports.2026_11');
    expect(out.autoFiled).toBe(true);
    // No tags asked: upsertFile gets none (its base `file` tag only).
    expect(h.upsertArgs[0]).not.toHaveProperty('tags');
  });

  it('an Admin-scope caller files a screenshot into Auto-filed / Screenshots / <month>, tagged', async () => {
    h.admin = true;
    const out = await saveExport({
      ownerId: 'o',
      filename: 'screenshot-2026-11-06-101500.png',
      bytes: Buffer.from('x'),
      source: 'screenshots',
      tags: ['screenshot'],
      data: { screenshot: { route: '/files' } },
    });
    expect(h.sources).toEqual(['screenshots']);
    expect(out.file.parentPath).toBe('files.auto_filed.screenshots.2026_11');
    expect(out.autoFiled).toBe(true);
    expect(h.upsertArgs[0]).toMatchObject({
      tags: ['screenshot'],
      data: { screenshot: { route: '/files' } },
      exportSave: true,
    });
  });

  it('anyone else: the Files root, whatever the source, and Auto-filed is never made', async () => {
    const out = await saveExport({
      ownerId: 'o',
      filename: 'screenshot-2026-11-06-101500.png',
      bytes: Buffer.from('x'),
      source: 'screenshots',
      tags: ['screenshot'],
    });
    expect(h.sources).toEqual([]);
    expect(out.file.parentPath).toBe('files');
    expect(out.autoFiled).toBe(false);
    expect(out.landedIn).toEqual({ id: 'ws-1', name: 'Home' });
  });

  it('a taken screenshot name takes the next free one', async () => {
    h.taken.add('screenshot-2026-11-06-101500.png');
    const out = await saveExport({
      ownerId: 'o',
      filename: 'screenshot-2026-11-06-101500.png',
      bytes: Buffer.from('x'),
      source: 'screenshots',
    });
    expect(out.file.filename).toBe('screenshot-2026-11-06-101500-2.png');
  });
});

/**
 * The names of a file's database: the 64-hex check, the two names, the word,
 * and the removals, which match by a readdir and a prefix, leave a write in
 * flight alone, and never throw. On a temporary files root; no database.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileDbNameExists,
  fileDbPaths,
  fileDbSqlitePath,
  fileDbsDir,
  isFileSha256,
  readFileDbNone,
  removeFileDbNames,
  removeFileDbNamesAfterCommit,
  removeOtherFileDbNames,
  writeFileDbNone,
} from './file-dbs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-file-dbs-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const touch = (name: string) => {
  mkdirSync(fileDbsDir(), { recursive: true });
  writeFileSync(path.join(fileDbsDir(), name), 'x');
};
const left = () => readdirSync(fileDbsDir()).sort();

describe('the names', () => {
  it('builds both from the id and the first 16 of the sha256, in the dot folder', () => {
    const names = fileDbPaths(ID, SHA_A)!;
    const base = path.join(root, '.file-dbs', `${ID}.${'a'.repeat(16)}`);
    expect(names).toEqual({ sqlite: `${base}.sqlite`, none: `${base}.none` });
  });

  it('names nothing without 64 hex characters, or from an unsafe id', () => {
    for (const bad of [undefined, null, '', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 7]) {
      expect(isFileSha256(bad), String(bad)).toBe(false);
      expect(fileDbPaths(ID, bad), String(bad)).toBeNull();
    }
    expect(fileDbPaths('../evil', SHA_A)).toBeNull();
  });

  it('reads back which name exists', async () => {
    expect(await fileDbNameExists(ID, SHA_A)).toBe(false);
    expect(await fileDbSqlitePath(ID, SHA_A)).toBeNull();
    touch(`${ID}.${'a'.repeat(16)}.sqlite`);
    expect(await fileDbNameExists(ID, SHA_A)).toBe(true);
    expect(await fileDbSqlitePath(ID, SHA_A)).toBe(fileDbPaths(ID, SHA_A)!.sqlite);
    expect(await fileDbNameExists(ID, SHA_B)).toBe(false);
  });
});

describe('the word', () => {
  it('writes one word, read back, with no temp file left', async () => {
    expect(await readFileDbNone(ID, SHA_A)).toBeNull();
    await writeFileDbNone(ID, SHA_A, 'too-large');
    expect(await readFileDbNone(ID, SHA_A)).toBe('too-large');
    expect(await fileDbNameExists(ID, SHA_A)).toBe(true);
    expect(left()).toEqual([`${ID}.${'a'.repeat(16)}.none`]);
  });

  it('a word from a parse removes the database of the same bytes, and no other name', async () => {
    const a = 'a'.repeat(16);
    for (const side of ['', '-journal', '-wal', '-shm']) touch(`${ID}.${a}.sqlite${side}`);
    touch(`${ID}.${'b'.repeat(16)}.sqlite`);
    touch(`${OTHER}.${a}.sqlite`);
    await writeFileDbNone(ID, SHA_A, 'no-rows', { parsed: true });
    expect(await fileDbSqlitePath(ID, SHA_A)).toBeNull();
    expect(left()).toEqual(
      [`${ID}.${a}.none`, `${ID}.${'b'.repeat(16)}.sqlite`, `${OTHER}.${a}.sqlite`].sort(),
    );
  });

  it('a word from a failure leaves the database of the same bytes', async () => {
    const a = 'a'.repeat(16);
    for (const side of ['', '-wal']) touch(`${ID}.${a}.sqlite${side}`);
    for (const word of ['unreadable', 'too-large'] as const) {
      await writeFileDbNone(ID, SHA_A, word);
      expect(await readFileDbNone(ID, SHA_A)).toBe(word);
      expect(await fileDbSqlitePath(ID, SHA_A)).toBe(fileDbPaths(ID, SHA_A)!.sqlite);
    }
    expect(left()).toEqual([`${ID}.${a}.none`, `${ID}.${a}.sqlite`, `${ID}.${a}.sqlite-wal`]);
  });

  it('reads anything else as unreadable', async () => {
    touch(`${ID}.${'a'.repeat(16)}.none`);
    expect(await readFileDbNone(ID, SHA_A)).toBe('unreadable');
  });

  it('refuses a row with no valid sha256', async () => {
    await expect(writeFileDbNone(ID, 'nope', 'no-rows')).rejects.toThrow(/cannot name/);
  });
});

describe('the removals', () => {
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  const seed = () => {
    touch(`${ID}.${a}.sqlite`);
    touch(`${ID}.${a}.sqlite-journal`);
    touch(`${ID}.${a}.none`);
    touch(`${ID}.${b}.sqlite`);
    // Another file's name, and a write in flight, stay whatever happens.
    touch(`${OTHER}.${a}.sqlite`);
    touch(`${ID}.${a}.sqlite.build-1-abcd1234`);
    // Not a name of this shape: a prefix alone does not make it one.
    touch(`${ID}.notes.txt`);
  };

  it('remove-all takes every finished name of this file, and nothing else', async () => {
    seed();
    await removeFileDbNames(ID);
    expect(left()).toEqual(
      [`${OTHER}.${a}.sqlite`, `${ID}.${a}.sqlite.build-1-abcd1234`, `${ID}.notes.txt`].sort(),
    );
  });

  it('remove-other keeps the current sha16, sidecars included', async () => {
    seed();
    await removeOtherFileDbNames(ID, SHA_A);
    expect(existsSync(path.join(fileDbsDir(), `${ID}.${b}.sqlite`))).toBe(false);
    expect(existsSync(path.join(fileDbsDir(), `${ID}.${a}.sqlite`))).toBe(true);
    expect(existsSync(path.join(fileDbsDir(), `${ID}.${a}.sqlite-journal`))).toBe(true);
    expect(existsSync(path.join(fileDbsDir(), `${ID}.${a}.none`))).toBe(true);
  });

  it('remove-other with no valid sha256 keeps none of them', async () => {
    touch(`${ID}.${a}.sqlite`);
    await removeOtherFileDbNames(ID, null);
    expect(left()).toEqual([]);
  });

  it('a missing folder is not an error', async () => {
    await expect(removeFileDbNames(ID)).resolves.toBeUndefined();
    await expect(removeOtherFileDbNames(ID, SHA_A)).resolves.toBeUndefined();
    await expect(removeFileDbNamesAfterCommit(ID)).resolves.toBeUndefined();
  });

  it('a failure logs and never throws', async () => {
    touch(`${ID}.${a}.sqlite`);
    const seen = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A name that is a folder: fs.rm with force still refuses it.
    mkdirSync(path.join(fileDbsDir(), `${ID}.${b}.sqlite`));
    await expect(removeFileDbNames(ID)).resolves.toBeUndefined();
    expect(seen).toHaveBeenCalled();
    seen.mockRestore();
  });

  it('outside any transaction the delete has committed: the names go now', async () => {
    touch(`${ID}.${a}.sqlite`);
    await removeFileDbNamesAfterCommit(ID);
    expect(left()).toEqual([]);
  });
});

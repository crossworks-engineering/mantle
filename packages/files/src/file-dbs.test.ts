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
  fileIdsWithDatabase,
  finishedFileDbNames,
  isFileSha256,
  listFileDbFolder,
  readFileDbNone,
  readFileDbNoneStamp,
  readWindowStage,
  removeFileDbNames,
  removeFileDbNamesAfterCommit,
  removeOtherFileDbNames,
  removeOtherWindowStages,
  removeWindowStage,
  writeFileDbNone,
  writeWindowStage,
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

  it('a word with the stamp of a Reader of text: the first line is the word, the second the stamp', async () => {
    const stamp = {
      pipeline_id: 'qnote-field-note',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    };
    await writeFileDbNone(ID, SHA_A, 'no-rows', { parsed: true, stamp });
    const raw = readdirSync(fileDbsDir()).find((n) => n.endsWith('.none'))!;
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path.join(fileDbsDir(), raw), 'utf8')).toBe(
      `no-rows\n${JSON.stringify(stamp)}\n`,
    );
    expect(await readFileDbNone(ID, SHA_A)).toBe('no-rows');
    expect(await readFileDbNoneStamp(ID, SHA_A)).toEqual(stamp);
    // A word of one line has no stamp, and reads as before.
    await writeFileDbNone(ID, SHA_B, 'no-rows', { parsed: true });
    expect(await readFileDbNoneStamp(ID, SHA_B)).toBeNull();
    expect(await readFileDbNone(ID, SHA_B)).toBe('no-rows');
    // The look's ids take a word only when asked.
    expect(await fileIdsWithDatabase()).toEqual([]);
    expect(await fileIdsWithDatabase({ words: true })).toEqual([ID]);
  });

  it('a word file of an old form (no newline) still reads as its word', async () => {
    mkdirSync(fileDbsDir(), { recursive: true });
    writeFileSync(path.join(fileDbsDir(), `${ID}.${'a'.repeat(16)}.none`), 'too-large');
    expect(await readFileDbNone(ID, SHA_A)).toBe('too-large');
    expect(await readFileDbNoneStamp(ID, SHA_A)).toBeNull();
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

describe('the window stage', () => {
  const RUN = '0123456789abcdef';
  const RUN2 = 'fedcba9876543210';
  const stageName = (id: string, sha: string, run: string, from: number) =>
    `${id}.${sha.slice(0, 16)}.stage-${run}-${from}.json`;

  it('keeps a window under the file, its bytes and its run, read back by first page', async () => {
    expect(await writeWindowStage(ID, SHA_A, RUN, 1, '{"one":1}')).toBe(true);
    expect(await writeWindowStage(ID, SHA_A, RUN, 51, '{"two":2}')).toBe(true);
    // Another run and other bytes of the same file, and another file.
    await writeWindowStage(ID, SHA_A, RUN2, 1, 'run2');
    await writeWindowStage(ID, SHA_B, RUN, 1, 'sha-b');
    await writeWindowStage(OTHER, SHA_A, RUN, 1, 'other');
    expect(left()).toContain(stageName(ID, SHA_A, RUN, 51));
    // No temp file is left.
    expect(left().some((n) => n.includes('.build-'))).toBe(false);
    const kept = await readWindowStage(ID, SHA_A, RUN);
    expect([...kept.keys()].sort((a, b) => a - b)).toEqual([1, 51]);
    expect(await kept.get(1)!()).toBe('{"one":1}');
    expect(await kept.get(51)!()).toBe('{"two":2}');
    const b = await readWindowStage(ID, SHA_B, RUN);
    expect(await b.get(1)!()).toBe('sha-b');
    // A file gone since the listing reads as null.
    rmSync(path.join(fileDbsDir(), stageName(ID, SHA_A, RUN, 51)));
    expect(await kept.get(51)!()).toBeNull();
  });

  it('names nothing from bad parts', async () => {
    expect(await writeWindowStage(ID, 'nope', RUN, 1, 'x')).toBe(false);
    expect(await writeWindowStage('../evil', SHA_A, RUN, 1, 'x')).toBe(false);
    expect(await writeWindowStage(ID, SHA_A, 'NOT-HEX', 1, 'x')).toBe(false);
    expect(await writeWindowStage(ID, SHA_A, RUN, 0, 'x')).toBe(false);
    expect((await readWindowStage(ID, 'nope', RUN)).size).toBe(0);
  });

  it('is no database: the lists of names never show it', async () => {
    await writeWindowStage(ID, SHA_A, RUN, 1, 'x');
    expect(await fileIdsWithDatabase({ words: true })).toEqual([]);
    expect((await finishedFileDbNames()).size).toBe(0);
    expect(await listFileDbFolder()).toEqual({ names: [], builds: [] });
    expect(await fileDbNameExists(ID, SHA_A)).toBe(false);
  });

  it('the end of a build removes every run of these bytes, and nothing else', async () => {
    await writeWindowStage(ID, SHA_A, RUN, 1, 'x');
    await writeWindowStage(ID, SHA_A, RUN2, 1, 'x');
    await writeWindowStage(ID, SHA_B, RUN, 1, 'x');
    await writeWindowStage(OTHER, SHA_A, RUN, 1, 'x');
    touch(`${ID}.${'a'.repeat(16)}.sqlite`);
    await removeWindowStage(ID, SHA_A);
    expect(left()).toEqual(
      [
        `${ID}.${'a'.repeat(16)}.sqlite`,
        stageName(ID, SHA_B, RUN, 1),
        stageName(OTHER, SHA_A, RUN, 1),
      ].sort(),
    );
  });

  it('new bytes remove the stage of older ones (the extract, and the build of a database)', async () => {
    await writeWindowStage(ID, SHA_A, RUN, 1, 'x');
    await writeWindowStage(ID, SHA_B, RUN, 1, 'x');
    await removeOtherWindowStages(ID, SHA_B);
    expect(left()).toEqual([stageName(ID, SHA_B, RUN, 1)]);
    await writeWindowStage(ID, SHA_A, RUN, 1, 'x');
    await removeOtherFileDbNames(ID, SHA_B);
    expect(left()).toEqual([stageName(ID, SHA_B, RUN, 1)]);
  });

  it('a delete, or a turn to private, removes it with every name of the file', async () => {
    await writeWindowStage(ID, SHA_A, RUN, 1, 'x');
    await writeWindowStage(ID, SHA_B, RUN2, 51, 'x');
    await writeWindowStage(OTHER, SHA_A, RUN, 1, 'x');
    await removeFileDbNames(ID);
    expect(left()).toEqual([stageName(OTHER, SHA_A, RUN, 1)]);
  });

  it('a missing folder is not an error', async () => {
    expect((await readWindowStage(ID, SHA_A, RUN)).size).toBe(0);
    await removeWindowStage(ID, SHA_A);
    await removeOtherWindowStages(ID, SHA_A);
  });
});

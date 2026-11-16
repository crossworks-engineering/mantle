/**
 * The one memo of a Reader's run (./reader-memo.ts): one run for the
 * passes that ask, the promise in flight shared, the key's parts, a failure
 * kept for the rest of its parser scope and given back as it was thrown,
 * and the two queues of two runs (CAD's, and the other Readers'), so
 * neither pushes the other's runs out. The text pass with a Reader
 * (./parse.ts) takes the Reader only where the core has no text route.
 */
import { describe, expect, it, vi } from 'vitest';
import { ParserError, withParserScope } from './parser-client';
import { parseDocumentBytes } from './parse';
import {
  keptReaderRun,
  memoReaderRun,
  READER_MEMO_MAX,
  readerRunFailure,
  readerRunKey,
} from './reader-memo';

const P = { id: 'qnote-field-note', version: '1.0.0' };
const sha = (n: number) => String(n).repeat(64).slice(0, 64);
const key = (n: number) => readerRunKey(P, sha(n), 'qnote');
/** A run of the built-in CAD reader: the key `cadRun` makes (./dwg.ts). */
const cadKey = (n: number) => readerRunKey({ id: 'drawing-cad', version: '1.0.0' }, sha(n), 'dwg');

describe('the one memo of a Reader run', () => {
  it('runs once for the passes that ask, the run in flight shared', async () => {
    const run = vi.fn(async () => 'ran');
    const k = key(1);
    const [a, b] = await Promise.all([memoReaderRun(k, run), memoReaderRun(k, run)]);
    expect(await memoReaderRun(k, run)).toBe('ran');
    expect([a, b]).toEqual(['ran', 'ran']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await keptReaderRun(k)).toBe('ran');
  });

  it('the key names the id, the version, a draft, the bytes, the extension and the rest', () => {
    const sha = 'f'.repeat(64);
    expect(readerRunKey(P, sha, 'qnote')).toBe(`qnote-field-note@1.0.0:${sha}:qnote`);
    expect(readerRunKey({ ...P, draft: 'd1' }, sha, 'qnote', 'ab12cd34')).toBe(
      `qnote-field-note@1.0.0#d1:${sha}:qnote:ab12cd34`,
    );
  });

  it('a failure is kept in its scope, as thrown, and asked afresh outside it', async () => {
    const err = new ParserError('timeout', 'a made-up timeout', {
      retryable: true,
      terminal: false,
    });
    const failing = vi.fn(async () => {
      throw err;
    });
    const k = key(2);
    await withParserScope({}, async () => {
      await expect(memoReaderRun(k, failing)).rejects.toBe(err);
      await expect(memoReaderRun(k, failing)).rejects.toBe(err);
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(readerRunFailure(k)).toBe('timeout: a made-up timeout');
    // Another scope (the extract's retry) asks again; a success clears the words.
    expect(await memoReaderRun(k, async () => 'ok')).toBe('ok');
    expect(readerRunFailure(k)).toBeUndefined();
  });

  it('keeps two runs in each queue, the oldest goes first', async () => {
    expect(READER_MEMO_MAX).toBe(2);
    const run = vi.fn(async () => 'x');
    for (const n of [3, 4, 5]) await memoReaderRun(key(n), run);
    expect(keptReaderRun(key(3))).toBeUndefined();
    expect(keptReaderRun(key(4))).toBeDefined();
    expect(keptReaderRun(key(5))).toBeDefined();
    for (const n of [1, 2, 3]) await memoReaderRun(cadKey(n), run);
    expect(keptReaderRun(cadKey(1))).toBeUndefined();
    expect(keptReaderRun(cadKey(2))).toBeDefined();
    expect(keptReaderRun(cadKey(3))).toBeDefined();
  });

  it('a CAD run survives any number of own Reader runs', async () => {
    const run = vi.fn(async () => 'x');
    await memoReaderRun(cadKey(6), run);
    for (let n = 10; n < 30; n += 1) await memoReaderRun(key(n), run);
    expect(keptReaderRun(cadKey(6))).toBeDefined();
  });

  it('an own Reader run survives any number of CAD runs', async () => {
    const run = vi.fn(async () => 'x');
    await memoReaderRun(key(6), run);
    for (let n = 10; n < 30; n += 1) await memoReaderRun(cadKey(n), run);
    expect(keptReaderRun(key(6))).toBeDefined();
  });

  it('a failure’s words are kept in the queue of its run', async () => {
    const err = new ParserError('failed', 'a made-up failure', {
      retryable: false,
      terminal: false,
    });
    await withParserScope({}, async () => {
      await expect(memoReaderRun(cadKey(40), async () => Promise.reject(err))).rejects.toBe(err);
    });
    for (let n = 41; n < 50; n += 1) {
      await withParserScope({}, async () => {
        await expect(memoReaderRun(key(n), async () => Promise.reject(err))).rejects.toBe(err);
      });
    }
    expect(readerRunFailure(cadKey(40))).toBe('failed: a made-up failure');
  });
});

describe('the text pass with a Reader', () => {
  it('takes the Reader where the core has no text route, and the core’s text where it has one', async () => {
    const reader = vi.fn(async () => 'the reader’s text');
    expect(await parseDocumentBytes(Buffer.from('QNOTE 1'), 'qnote', reader)).toBe(
      'the reader’s text',
    );
    // .json is the core's (UTF-8): the Reader is not asked.
    expect(await parseDocumentBytes(Buffer.from('{"a":1}'), 'json', reader)).toBe('{"a":1}');
    expect(reader).toHaveBeenCalledTimes(1);
    // With no Reader, a format no reader takes is '' as before.
    expect(await parseDocumentBytes(Buffer.from('QNOTE 1'), 'qnote')).toBe('');
  });
});

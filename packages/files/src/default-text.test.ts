/**
 * The default text of a file no reader takes: name, type, size and, for an
 * archive, its entry names. The archives here are built by hand, byte for
 * byte, so the test needs no archive library.
 */

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_HEADERS,
  MAX_LIST_CHARS,
  MAX_NAME_BYTES,
  MAX_NAME_CHARS,
  MAX_NAMES,
  MAX_PAX_BYTES,
  MAX_WALK_MS,
  archiveNames,
  defaultFileText,
  isDefaultFileText,
  sizeInWords,
} from './default-text';

/** A ZIP of stored (not deflated) entries. A name can be given as bytes.
 *  `noFlag`: the entries do not say their names are UTF-8. */
function zip(
  names: Array<string | Buffer>,
  opts: { claim?: number; prefix?: Buffer; noFlag?: boolean } = {},
): Buffer {
  const flag = opts.noFlag ? 0 : 0x0800;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = opts.prefix?.length ?? 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const data = Buffer.from('x');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flag, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flag, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(opts.claim ?? names.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(opts.claim ?? names.length, 0xffff), 10);
  end.writeUInt32LE(dir.length, 12);
  // With a prefix the stored offset is wrong, as in a self-extracting file.
  end.writeUInt32LE(offset - (opts.prefix?.length ?? 0), 16);
  return Buffer.concat([opts.prefix ?? Buffer.alloc(0), ...locals, dir, end]);
}

/** One TAR header block. */
function tarHeader(
  name: string,
  size: number,
  type = '0',
  prefix = '',
  magic = 'ustar\x0000',
): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write(magic, 257);
  h.write(prefix, 345, 155, 'utf8');
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

const padded = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** A TAR: `[name, data]` entries, then the two zero blocks of the end. */
function tar(entries: Array<[string, string]>, end = true): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    parts.push(tarHeader(name, data.length), padded(data));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const many = (n: number) => Array.from({ length: n }, (_, i) => `dir/file-${i}.txt`);

/** One pax record: "<len> <key>=<value>\n", where len counts itself. */
function paxRecord(key: string, value: string): string {
  const line = ` ${key}=${value}\n`;
  let len = line.length + 1;
  while (`${len}${line}`.length !== len) len = `${len}${line}`.length;
  return `${len}${line}`;
}

/** No time limit: the test is for another limit, on a box of any speed. */
const NO_CLOCK = Number.POSITIVE_INFINITY;

/** 400 control characters of two bytes each: {@link MAX_NAME_BYTES} bytes
 *  that clean to nothing. A name that goes on after them shows whether the
 *  read stopped at the limit. */
const HIDDEN = '\u0085'.repeat(MAX_NAME_BYTES / 2);

describe('defaultFileText', () => {
  it('an unknown type: the name, the type and the size, and no list', async () => {
    const text = await defaultFileText({
      filename: 'site-logger.lx9',
      ext: 'lx9',
      mime: 'application/octet-stream',
      bytes: Buffer.alloc(2048, 7),
    });
    expect(text).toContain('File name: site-logger.lx9');
    expect(text).toContain('File type: .lx9');
    expect(text).toContain('File size: 2.0 KB (2048 bytes)');
    expect(text).toContain('There is no reader for this file type.');
    expect(text).not.toContain('Entries in the archive');
    expect(isDefaultFileText(text)).toBe(true);
  });

  it('no extension, a known mime, and no bytes', async () => {
    const text = await defaultFileText({
      filename: 'LICENSE-BLOB',
      ext: '',
      mime: 'application/x-thing',
      bytes: null,
    });
    expect(text).toContain('File type: no extension, application/x-thing');
    expect(text).not.toContain('File size');
  });

  it('a ZIP: the names of its entries', async () => {
    const text = await defaultFileText({
      filename: 'handover.zip',
      ext: 'zip',
      bytes: zip(['drawings/P-101.dwg', 'drawings/P-102.dwg', 'readme.txt']),
    });
    expect(text).toContain('File type: ZIP archive (.zip)');
    expect(text).toContain('Entries in the archive (3, names only):');
    expect(text).toContain('- drawings/P-101.dwg\n- drawings/P-102.dwg\n- readme.txt');
    expect(text).not.toContain('more');
  });

  it('a ZIP whose stored directory offset is wrong: the directory is found from the end record', async () => {
    const got = await archiveNames(zip(['a.txt', 'b.txt'], { prefix: Buffer.alloc(0) }));
    expect(got?.names).toEqual(['a.txt', 'b.txt']);
    const sfx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(996)]);
    const moved = await archiveNames(zip(['a.txt', 'b.txt'], { prefix: sfx }));
    expect(moved?.names).toEqual(['a.txt', 'b.txt']);
  });

  it('a TAR: the names, a long GNU name and a pax path too', async () => {
    const long = `${'deep/'.repeat(30)}end.txt`;
    const pax = `${'other/'.repeat(25)}pax.txt`;
    const record = (body: string) => paxRecord('path', body);
    const bytes = Buffer.concat([
      tarHeader('first.txt', 2),
      padded(Buffer.from('hi')),
      tarHeader('././@LongLink', long.length + 1, 'L'),
      padded(Buffer.from(`${long}\0`)),
      tarHeader(long.slice(0, 100), 0),
      tarHeader('PaxHeader', record(pax).length, 'x'),
      padded(Buffer.from(record(pax))),
      tarHeader('short', 0),
      tarHeader('name.txt', 0, '0', 'with/prefix'),
      Buffer.alloc(1024),
    ]);
    const got = await archiveNames(bytes);
    expect(got).toEqual({
      kind: 'TAR archive',
      names: ['first.txt', long, pax, 'with/prefix/name.txt'],
      total: 4,
    });
  });

  it('a GNU TAR header: the bytes at 345 are times, not a prefix of the name', async () => {
    const gnu = tarHeader('gnu.txt', 0, '0', '14712345670\x0014712345671', 'ustar  \0');
    const got = await archiveNames(Buffer.concat([gnu, Buffer.alloc(1024)]));
    expect(got).toEqual({ kind: 'TAR archive', names: ['gnu.txt'], total: 1 });
  });

  it('a ZIP name in UTF-8 with no UTF-8 flag is read as UTF-8', async () => {
    const got = await archiveNames(zip(['чертежи/план.dwg'], { noFlag: true }));
    expect(got?.names).toEqual(['чертежи/план.dwg']);
    // A long one: the cut at the byte limit breaks its last character, and
    // that does not make the name latin1.
    const long = await archiveNames(zip([`a${'я'.repeat(450)}`], { noFlag: true }));
    expect(long?.names).toEqual([`a${'я'.repeat(MAX_NAME_CHARS - 1)}...`]);
  });

  it('a ZIP name with no UTF-8 flag that is not UTF-8 is read as latin1', async () => {
    const name = Buffer.from('caf\xe9.txt', 'latin1');
    const got = await archiveNames(zip([name], { noFlag: true }));
    expect(got?.names).toEqual(['café.txt']);
  });

  it('a TAR in gzip is not inflated: its kind, its name and its size, and no list', async () => {
    const bytes = zlib.gzipSync(
      tar([
        ['logs/a.log', 'one'],
        ['logs/b.log', 'two'],
      ]),
    );
    expect(await archiveNames(bytes)).toEqual({ kind: 'gzip file', names: [], total: null });
    const text = await defaultFileText({ filename: 'foo.tar.gz', ext: 'gz', bytes });
    expect(text).toContain('File name: foo.tar.gz');
    expect(text).toContain('File type: gzip file (.gz)');
    expect(text).toContain(`File size: ${sizeInWords(bytes.length)}`);
    expect(text).not.toContain('Entries in the archive');
    expect(text).not.toContain('logs/');
  });
});

describe('the limits', () => {
  it(`a ZIP of more than ${MAX_NAMES} entries: ${MAX_NAMES} names, then "and N more"`, async () => {
    const text = await defaultFileText({
      filename: 'big.zip',
      ext: 'zip',
      bytes: zip(many(MAX_NAMES + 100)),
    });
    expect(text.match(/^- dir\//gm)).toHaveLength(MAX_NAMES);
    expect(text).toContain(`Entries in the archive (${MAX_NAMES + 100}, names only):`);
    expect(text.endsWith('- and 100 more')).toBe(true);
  });

  it('a TAR of more than the limit: the same', async () => {
    const got = await archiveNames(tar(many(MAX_NAMES + 7).map((n) => [n, ''])));
    expect(got?.names).toHaveLength(MAX_NAMES);
    expect(got?.total).toBe(MAX_NAMES + 7);
  });

  it('a count the ZIP cannot hold is not shown', async () => {
    const text = await defaultFileText({
      filename: 'liar.zip',
      ext: 'zip',
      bytes: zip(['a.txt', 'b.txt'], { claim: 60_000 }),
    });
    expect(text).toContain('Entries in the archive (names only):');
    expect(text).toContain('- a.txt\n- b.txt\n- and more');
    expect(text).not.toContain('60000');
  });

  it('long names: the list stops at its character limit', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `${i}-${'n'.repeat(190)}`);
    const got = await archiveNames(zip(names));
    const chars = got!.names.reduce((sum, n) => sum + n.length, 0);
    expect(got!.names.length).toBeLessThan(300);
    expect(chars).toBeLessThan(MAX_LIST_CHARS + MAX_NAME_CHARS + 4);
    expect(got!.total).toBe(300);
  });

  it('a name with line breaks and control characters is one clean line', async () => {
    const text = await defaultFileText({
      filename: 'x.zip',
      ext: 'zip',
      bytes: zip(['evil\nFile name: other\u0000\u001b[31m.txt']),
    });
    expect(text).toContain('- evil File name: other [31m.txt');
    expect(text.split('\n').filter((l) => l.startsWith('File name: '))).toHaveLength(1);
  });

  it('a name is cut on a whole character, never in the middle of a pair', async () => {
    const wellFormed = (s: string) => Buffer.from(s, 'utf8').toString('utf8') === s;
    // The cut at 200 falls between the two halves of the emoji.
    const name = `${'a'.repeat(MAX_NAME_CHARS - 1)}\u{1f600} and more text.bin`;
    const got = await archiveNames(zip([name]));
    expect(got!.names).toEqual([`${'a'.repeat(MAX_NAME_CHARS - 1)}...`]);
    const listed = await defaultFileText({ filename: 'x.zip', ext: 'zip', bytes: zip([name]) });
    expect(wellFormed(listed)).toBe(true);
    const named = await defaultFileText({ filename: name, ext: 'bin', bytes: null });
    expect(named).toContain(`File name: ${'a'.repeat(MAX_NAME_CHARS - 1)}...\n`);
    expect(wellFormed(named)).toBe(true);
    // A name that is short keeps its emoji.
    const short = await defaultFileText({ filename: 'ok \u{1f600}.bin', ext: 'bin', bytes: null });
    expect(short).toContain('File name: ok \u{1f600}.bin');
  });

  it('a ZIP whose names all clean to nothing: no names, and the true count', async () => {
    const small = zip(Array.from({ length: 300 }, () => '\u0001'));
    const got = await archiveNames(small);
    expect(got?.kind).toBe('ZIP archive');
    expect(got?.names).toEqual([]);
    expect(got?.total).toBe(300);
    const text = await defaultFileText({ filename: 'empty-names.zip', ext: 'zip', bytes: small });
    expect(text).not.toContain('Entries in the archive');
  });

  it('a ZIP walk stops at the entry limit: an entry past it is not read, and no count', async () => {
    expect(MAX_HEADERS).toBe(100_000);
    // No name before the limit is listed, so the list never fills: only the
    // entry limit keeps the walk from the one real name after it.
    const names = Array.from({ length: MAX_HEADERS + 1 }, () => '\u0001');
    names[MAX_HEADERS] = 'past-the-limit.txt';
    const over = await archiveNames(zip(names), NO_CLOCK);
    expect(over).toEqual({ kind: 'ZIP archive', names: [], total: null });
    // One entry less: the real name is the last one read.
    const under = await archiveNames(zip(names.slice(1)), NO_CLOCK);
    expect(under?.names).toEqual(['past-the-limit.txt']);
  }, 30_000);

  it('a TAR walk stops at the header limit: no count past it, the true count under it', async () => {
    // About 51 MB of headers, built one time. Entries of size 0, then the end.
    const count = MAX_HEADERS + 5;
    const bytes = Buffer.alloc(count * 512 + 1024);
    tarHeader('f.txt', 0).copy(bytes, 0);
    for (let i = 1; i < count; i += 1) bytes.copy(bytes, i * 512, 0, 512);
    const over = await archiveNames(bytes, NO_CLOCK);
    expect(over?.kind).toBe('TAR archive');
    expect(over?.names).toHaveLength(MAX_NAMES);
    expect(over?.total).toBeNull();
    // Ten headers less: the walk gets to the end of the archive.
    const under = await archiveNames(bytes.subarray(10 * 512), NO_CLOCK);
    expect(under?.names).toHaveLength(MAX_NAMES);
    expect(under?.total).toBe(MAX_HEADERS - 5);
  }, 30_000);

  it('the clock: a walk that is out of time reads no name and gives no count', async () => {
    expect(MAX_WALK_MS).toBe(1_000);
    const names = ['a.txt', 'b.txt', 'c.txt'];
    // A deadline of 0 is in the past: the first check of the clock stops
    // the walk, before any name is read.
    expect(await archiveNames(zip(names), 0)).toEqual({
      kind: 'ZIP archive',
      names: [],
      total: null,
    });
    // The first header says it is a TAR; the clock is read before its name.
    expect(await archiveNames(tar(names.map((n) => [n, 'x'])), 0)).toEqual({
      kind: 'TAR archive',
      names: [],
      total: null,
    });
    // With the default clock the same archives are read in full.
    expect((await archiveNames(zip(names)))?.total).toBe(3);
    expect((await archiveNames(tar(names.map((n) => [n, 'x']))))?.total).toBe(3);
  });

  it('a TAR of long names made of NULs is walked fast (no slow regex)', async () => {
    const data = Buffer.alloc(8192);
    data.write('a', 8191);
    const one = Buffer.concat([
      tarHeader('././@LongLink', data.length, 'L'),
      padded(data),
      tarHeader('n.txt', 0),
    ]);
    const bytes = Buffer.concat([...Array.from({ length: 400 }, () => one), Buffer.alloc(1024)]);
    const started = Date.now();
    const got = await archiveNames(bytes);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(got?.kind).toBe('TAR archive');
  });

  it('a ZIP of long names that clean to nothing is walked fast (one clock, one name size)', async () => {
    // 3 000 directory entries, each with a name of 65 535 bytes. No locals:
    // the walk reads the directory only.
    const count = 3_000;
    const entry = Buffer.alloc(46 + 0xffff);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0xffff, 28);
    entry.fill('\x01 ', 46);
    const bytes = Buffer.alloc(4 + count * entry.length + 22);
    bytes.write('PK\x03\x04', 0, 'latin1');
    for (let i = 0; i < count; i += 1) entry.copy(bytes, 4 + i * entry.length);
    const end = bytes.length - 22;
    bytes.writeUInt32LE(0x06054b50, end);
    bytes.writeUInt16LE(count, end + 8);
    bytes.writeUInt16LE(count, end + 10);
    bytes.writeUInt32LE(count * entry.length, end + 12);
    bytes.writeUInt32LE(4, end + 16);
    const started = Date.now();
    const got = await archiveNames(bytes);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(got?.kind).toBe('ZIP archive');
    expect(got?.names).toEqual([]);
  }, 30_000);

  it('a ZIP entry with a very long name: only the start of the name is read', async () => {
    expect(MAX_NAME_BYTES).toBe(MAX_NAME_CHARS * 4);
    const got = await archiveNames(zip(['a'.repeat(5000)]));
    expect(got?.names).toEqual([`${'a'.repeat(MAX_NAME_CHARS)}...`]);
    expect(got?.total).toBe(1);
  });

  it('a name is read up to its byte limit only: what comes after is not seen', async () => {
    expect(Buffer.byteLength(HIDDEN)).toBe(MAX_NAME_BYTES);
    // ZIP: the bytes that are read clean to nothing, so no name is listed.
    const zipped = await archiveNames(zip([`${HIDDEN}tail.txt`]));
    expect(zipped).toEqual({ kind: 'ZIP archive', names: [], total: 1 });
    // TAR, a GNU long name: the same.
    const long = Buffer.from(`${HIDDEN}tail.txt\0`);
    const tarred = await archiveNames(
      Buffer.concat([
        tarHeader('././@LongLink', long.length, 'L'),
        padded(long),
        tarHeader('short.txt', 0),
        Buffer.alloc(1024),
      ]),
    );
    expect(tarred).toEqual({ kind: 'TAR archive', names: [], total: 1 });
    // The name of the file itself: cut before it is cleaned.
    const named = await defaultFileText({
      filename: `${'\u0001'.repeat(MAX_NAME_BYTES)}tail.bin`,
      ext: 'bin',
      bytes: null,
    });
    expect(named.startsWith('File name: \n')).toBe(true);
  });

  it('a pax block is read up to its byte limit only: a path after it is not found', async () => {
    const pathAt = (commentChars: number) => {
      const block = Buffer.from(
        paxRecord('comment', 'c'.repeat(commentChars)) + paxRecord('path', 'from/pax.txt'),
      );
      return Buffer.concat([
        tarHeader('PaxHeader', block.length, 'x'),
        padded(block),
        tarHeader('own-name.txt', 0),
        Buffer.alloc(1024),
      ]);
    };
    // The path is past the limit: the header's own name stands.
    expect((await archiveNames(pathAt(MAX_PAX_BYTES)))?.names).toEqual(['own-name.txt']);
    // The path is inside the limit, after another record.
    expect((await archiveNames(pathAt(1000)))?.names).toEqual(['from/pax.txt']);
  });

  it('an empty long name: the next entry keeps its own name', async () => {
    const bytes = Buffer.concat([
      tarHeader('././@LongLink', 0, 'L'),
      tarHeader('real.txt', 0),
      Buffer.alloc(1024),
    ]);
    const got = await archiveNames(bytes);
    expect(got?.names).toEqual(['real.txt']);
  });
});

describe('a broken or hostile archive never fails the file', () => {
  const plain = async (bytes: Buffer, ext: string) => {
    const text = await defaultFileText({ filename: `bad.${ext}`, ext, bytes });
    expect(text).toContain(`File name: bad.${ext}`);
    expect(text).toContain(`File size: ${sizeInWords(bytes.length)}`);
    return text;
  };

  it('a ZIP cut off before its directory', async () => {
    const whole = zip(many(20));
    const text = await plain(whole.subarray(0, 200), 'zip');
    expect(text).not.toContain('Entries in the archive');
  });

  it('a ZIP whose directory points outside the file', async () => {
    const bytes = zip(['a.txt']);
    bytes.writeUInt32LE(0xfffffff0, bytes.length - 22 + 16);
    bytes.writeUInt32LE(0xfffffff0, bytes.length - 22 + 12);
    const text = await plain(bytes, 'zip');
    expect(text).not.toContain('- a.txt');
  });

  it('a ZIP whose name runs past the end of the file', async () => {
    const bytes = zip(['a.txt']);
    const central = bytes.length - 22 - 46 - 5;
    bytes.writeUInt16LE(0xffff, central + 28);
    await plain(bytes, 'zip');
  });

  it('a gzip of noise', async () => {
    const noise = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(300, 0xa5)]);
    const text = await plain(noise, 'gz');
    expect(text).toContain('File type: gzip file (.gz)');
    expect(text).not.toContain('Entries in the archive');
  });

  it('a TAR whose second header is noise keeps the first name', async () => {
    const bytes = Buffer.concat([tar([['ok.txt', 'x']], false), Buffer.alloc(512, 0x41)]);
    const got = await archiveNames(bytes);
    expect(got).toEqual({ kind: 'TAR archive', names: ['ok.txt'], total: null });
  });

  it('a TAR entry with a size that is not a number', async () => {
    const h = tarHeader('a.txt', 0);
    h.write('zzzzzzzzzzz\0', 124);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    await plain(Buffer.concat([h, Buffer.alloc(1024)]), 'tar');
  });

  it('bytes that are no archive, and an empty file', async () => {
    expect(await archiveNames(Buffer.alloc(4096, 0x55))).toBeNull();
    expect(await archiveNames(Buffer.alloc(0))).toBeNull();
    expect(await archiveNames(Buffer.from('PK\x03\x04'))).toBeNull();
    await plain(Buffer.alloc(0), 'bin');
  });
});

describe('isDefaultFileText', () => {
  it('is false for the text of a real document', () => {
    expect(isDefaultFileText('File name: something a person wrote')).toBe(false);
    expect(isDefaultFileText('Minutes of the meeting')).toBe(false);
  });
});

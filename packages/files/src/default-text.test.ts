/**
 * The default text of a file no reader takes: name, type, size and, for an
 * archive, its entry names. The archives here are built by hand, byte for
 * byte, so the test needs no archive library.
 */

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_INFLATE_BYTES,
  MAX_LIST_CHARS,
  MAX_NAME_CHARS,
  MAX_NAMES,
  archiveNames,
  defaultFileText,
  isDefaultFileText,
  sizeInWords,
} from './default-text';

/** A ZIP of stored (not deflated) entries. */
function zip(names: string[], opts: { claim?: number; prefix?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = opts.prefix?.length ?? 0;
  for (const name of names) {
    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from('x');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0800, 8);
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
function tarHeader(name: string, size: number, type = '0', prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
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
    expect(text).toContain('Mantle has no reader for this file type.');
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

  it('a ZIP with bytes in front of it (a self-extracting file)', async () => {
    const got = await archiveNames(zip(['a.txt', 'b.txt'], { prefix: Buffer.alloc(0) }));
    expect(got?.names).toEqual(['a.txt', 'b.txt']);
    const sfx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(996)]);
    const moved = await archiveNames(zip(['a.txt', 'b.txt'], { prefix: sfx }));
    expect(moved?.names).toEqual(['a.txt', 'b.txt']);
  });

  it('a TAR: the names, a long GNU name and a pax path too', async () => {
    const long = `${'deep/'.repeat(30)}end.txt`;
    const pax = `${'other/'.repeat(25)}pax.txt`;
    const record = (body: string) => {
      const line = ` path=${body}\n`;
      let len = line.length + 1;
      while (`${len}${line}`.length !== len) len = `${len}${line}`.length;
      return `${len}${line}`;
    };
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
      names: ['first.txt', long.slice(0, MAX_NAME_CHARS) + '...', pax, 'with/prefix/name.txt'],
      total: 4,
    });
  });

  it('a TAR in gzip, found by its bytes: the extension is `gz`', async () => {
    const bytes = zlib.gzipSync(tar([['logs/a.log', 'one'], ['logs/b.log', 'two']]));
    const text = await defaultFileText({ filename: 'foo-tar.gz', ext: 'gz', bytes });
    expect(text).toContain('File type: TAR archive in gzip (.gz)');
    expect(text).toContain('Entries in the archive (2, names only):');
    expect(text).toContain('- logs/a.log\n- logs/b.log');
  });

  it('a gzip that holds no TAR: its kind, and no list', async () => {
    const text = await defaultFileText({
      filename: 'server.log.gz',
      ext: 'gz',
      bytes: zlib.gzipSync(Buffer.from('a plain log line\n'.repeat(200))),
    });
    expect(text).toContain('File type: gzip file (.gz)');
    expect(text).not.toContain('Entries in the archive');
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

  it('a gzip that inflates past the limit stops, and says "and more"', async () => {
    // One real entry, then an entry whose data is far past the limit.
    const big = MAX_INFLATE_BYTES + 8 * 1024 * 1024;
    const bytes = zlib.gzipSync(
      Buffer.concat([tar([['first.txt', 'hi']], false), tarHeader('huge.bin', big), Buffer.alloc(big)]),
      { level: 1 },
    );
    expect(bytes.length).toBeLessThan(1024 * 1024);
    const started = Date.now();
    const got = await archiveNames(bytes);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(got).toEqual({
      kind: 'TAR archive in gzip',
      names: ['first.txt', 'huge.bin'],
      total: null,
    });
  }, 30_000);
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

  it('a gzip cut off in the middle keeps the names read before the cut', async () => {
    const whole = zlib.gzipSync(
      tar(Array.from({ length: 50 }, (_, i) => [`f${i}.bin`, String(Math.random()).repeat(400)])),
    );
    const text = await plain(whole.subarray(0, Math.floor(whole.length / 2)), 'tgz');
    expect(text).toContain('- f0.bin');
    expect(text).toContain('- and more');
  });

  it('a gzip of noise', async () => {
    const noise = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(300, 0xa5)]);
    const text = await plain(noise, 'gz');
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

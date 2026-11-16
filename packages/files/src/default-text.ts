/**
 * The default text of a file no reader takes (docs/parser.md, "A file no
 * reader takes"): its name, its type, its size and, for an archive, the
 * names of the entries in it. The extract gives this text to the normal
 * index work, so the file gets a summary and a place in meaning search. No
 * model is asked here.
 *
 * An archive is found by its first bytes, never by its extension (a
 * `Foo.tar.gz` is stored with the extension `gz`). Only names are read:
 *   - ZIP: the directory at the end of the file. Nothing is inflated.
 *   - TAR: the 512-byte headers. The data between them is jumped over.
 *   - TAR in gzip: inflated as a stream, in memory, and only the headers
 *     are looked at. No entry is kept and nothing goes to disk.
 * `.7z` and `.rar` get no list: their directories need a decoder.
 *
 * The file is an outside input, so the work has limits: {@link MAX_NAMES}
 * names, {@link MAX_NAME_CHARS} characters a name, {@link MAX_LIST_CHARS}
 * characters for the list, {@link MAX_TAR_HEADERS} headers,
 * {@link MAX_INFLATE_BYTES} inflated bytes and {@link MAX_INFLATE_MS} for a
 * gzip. A broken or hostile archive gives the text with no list, or with
 * the names read before the fault. It never throws.
 */

import zlib from 'node:zlib';

/** Names one list holds. The rest is one line: "and N more". */
export const MAX_NAMES = 500;
/** Characters of one name. */
export const MAX_NAME_CHARS = 200;
/** Characters of all the names of one list together. */
export const MAX_LIST_CHARS = 20_000;
/** TAR headers one walk reads (the count of entries past this is not known). */
export const MAX_TAR_HEADERS = 100_000;
/** Bytes a gzip may inflate to before the walk stops. */
export const MAX_INFLATE_BYTES = 64 * 1024 * 1024;
/** Time the walk of a gzip may take. */
export const MAX_INFLATE_MS = 2_000;

/** The names read from an archive. `total`: the count of entries, or null
 *  when the walk stopped before the end. */
export type ArchiveListing = {
  kind: 'ZIP archive' | 'TAR archive' | 'TAR archive in gzip' | 'gzip file';
  names: string[];
  total: number | null;
};

/** One name, safe for one line of text. */
function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f  ]+/g, ' ').trim();
  return s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS)}...` : s;
}

/** Holds the names of a list, with the limits. */
function nameList() {
  const names: string[] = [];
  let chars = 0;
  let count = 0;
  return {
    names,
    get count() {
      return count;
    },
    add(raw: string) {
      count += 1;
      if (names.length >= MAX_NAMES || chars >= MAX_LIST_CHARS) return;
      const name = cleanName(raw);
      if (!name) return;
      names.push(name);
      chars += name.length;
    },
  };
}

// ─── ZIP ───────────────────────────────────────────────────────────────

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;

const u32 = (b: Buffer, at: number) => (at >= 0 && at + 4 <= b.length ? b.readUInt32LE(at) : -1);

function zipNames(b: Buffer): ArchiveListing | null {
  // The end record: in the last 22 bytes plus a comment of at most 65535.
  const from = Math.max(0, b.length - 22 - 0xffff);
  let end = -1;
  for (let i = b.length - 22; i >= from; i -= 1) {
    if (b.readUInt32LE(i) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let total = b.readUInt16LE(end + 10);
  let size = b.readUInt32LE(end + 12);
  let start = b.readUInt32LE(end + 16);
  // ZIP64: the true numbers are in the record the locator points to.
  if (u32(b, end - 20) === ZIP64_LOCATOR) {
    const at = Number(b.readBigUInt64LE(end - 20 + 8));
    if (u32(b, at) === ZIP64_END && at + 56 <= b.length) {
      total = Number(b.readBigUInt64LE(at + 32));
      size = Number(b.readBigUInt64LE(at + 40));
      start = Number(b.readBigUInt64LE(at + 48));
    }
  }
  // Bytes in front of the zip (a self-extracting file) move the directory.
  if (u32(b, start) !== ZIP_CENTRAL) start = end - size;
  const list = nameList();
  let at = start;
  while (list.names.length < MAX_NAMES && u32(b, at) === ZIP_CENTRAL && at + 46 <= b.length) {
    const utf8 = (b.readUInt16LE(at + 8) & 0x0800) !== 0;
    const nameLen = b.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    if (at + 46 + nameLen > b.length) break;
    const before = list.names.length;
    list.add(b.toString(utf8 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen));
    if (list.names.length === before) break; // the list is full
    at = next;
  }
  // The count is the file's own word. One that cannot be true is not shown.
  const sane = Number.isSafeInteger(total) && total >= list.names.length && total * 46 <= b.length;
  return { kind: 'ZIP archive', names: list.names, total: sane ? total : null };
}

// ─── TAR ───────────────────────────────────────────────────────────────

const BLOCK = 512;

const field = (h: Buffer, at: number, len: number) => {
  const raw = h.subarray(at, at + len);
  const nul = raw.indexOf(0);
  return raw.toString('utf8', 0, nul < 0 ? len : nul);
};

/** The size field: octal text, or a binary number when the first bit is set. */
function tarSize(h: Buffer): number {
  if (h[124]! & 0x80) return Number(h.readBigUInt64BE(128));
  const n = parseInt(field(h, 124, 12).trim() || '0', 8);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/** A header is true when its checksum is. This is also the test for "a TAR". */
function tarHeaderOk(h: Buffer): boolean {
  const want = parseInt(field(h, 148, 8).trim(), 8);
  if (!Number.isFinite(want)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === want;
}

/** The `path` of a pax record block ("<len> path=<value>\n"). */
function paxPath(data: string): string | null {
  const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data);
  return m ? m[1]! : null;
}

/** Bytes kept of a long-name entry (GNU `L`, pax `x`). */
const MAX_LONG_NAME_BYTES = 8 * 1024;

/**
 * Reads TAR headers from the chunks it is fed. `feed` returns true when the
 * walk is done: the end of the archive, a header that is not one, or the
 * header limit. `tar`: false when the first block is not a TAR header.
 */
function tarWalker() {
  const list = nameList();
  let carry: Buffer | null = null;
  let skip = 0; // data bytes still to jump over
  let grab: { left: number; kind: string; parts: Buffer[]; kept: number } | null = null;
  let longName: string | null = null;
  let headers = 0;
  let state: 'open' | 'end' | 'stopped' = 'open';
  let tar: boolean | null = null;

  const header = (h: Buffer) => {
    if (h.every((x) => x === 0)) {
      state = 'end';
      return;
    }
    if (!tarHeaderOk(h)) {
      if (tar === null) tar = false;
      state = 'stopped';
      return;
    }
    tar = true;
    headers += 1;
    if (headers > MAX_TAR_HEADERS) {
      state = 'stopped';
      return;
    }
    const size = tarSize(h);
    if (size < 0) {
      state = 'stopped';
      return;
    }
    const type = String.fromCharCode(h[156]!);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L' || type === 'x') {
      // The next entry's name is this entry's data.
      grab = { left: size, kind: type, parts: [], kept: 0 };
      skip = padded - size;
      return;
    }
    skip = padded;
    if (type === 'g' || type === 'K') return; // no entry of its own
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    list.add(longName ?? (prefix && field(h, 257, 5) === 'ustar' ? `${prefix}/${name}` : name));
    longName = null;
  };

  return {
    list,
    get tar() {
      return tar === true;
    },
    get ended() {
      return state === 'end';
    },
    feed(chunk: Buffer): boolean {
      let b = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      let at = 0;
      while (state === 'open' && at < b.length) {
        if (grab) {
          const n = Math.min(grab.left, b.length - at);
          const room = MAX_LONG_NAME_BYTES - grab.kept;
          if (room > 0) {
            grab.parts.push(b.subarray(at, at + Math.min(n, room)));
            grab.kept += Math.min(n, room);
          }
          grab.left -= n;
          at += n;
          if (grab.left === 0) {
            const text = Buffer.concat(grab.parts).toString('utf8');
            longName = grab.kind === 'L' ? text.replace(/\0+$/, '') : paxPath(text);
            grab = null;
          }
          continue;
        }
        if (skip > 0) {
          const n = Math.min(skip, b.length - at);
          skip -= n;
          at += n;
          continue;
        }
        if (b.length - at < BLOCK) break;
        header(b.subarray(at, at + BLOCK));
        at += BLOCK;
      }
      if (state === 'open' && at < b.length) carry = Buffer.from(b.subarray(at));
      b = chunk; // drop the joined buffer
      return state !== 'open';
    },
  };
}

function tarListing(w: ReturnType<typeof tarWalker>, kind: ArchiveListing['kind']): ArchiveListing {
  return { kind, names: w.list.names, total: w.ended ? w.list.count : null };
}

function tarNames(b: Buffer): ArchiveListing | null {
  if (b.length < BLOCK) return null;
  const w = tarWalker();
  w.feed(b);
  return w.tar ? tarListing(w, 'TAR archive') : null;
}

// ─── gzip ──────────────────────────────────────────────────────────────

/** A gzip: the names of the TAR in it, or `gzip file` when it holds no TAR. */
async function gzipNames(b: Buffer): Promise<ArchiveListing> {
  const w = tarWalker();
  const gz = zlib.createGunzip();
  // A fault of the stream ends the read below; this keeps it from being unhandled.
  gz.on('error', () => {});
  const deadline = Date.now() + MAX_INFLATE_MS;
  let out = 0;
  try {
    gz.end(b);
    for await (const chunk of gz as AsyncIterable<Buffer>) {
      out += chunk.length;
      if (w.feed(chunk) || out > MAX_INFLATE_BYTES || Date.now() > deadline) break;
    }
  } catch {
    // A broken gzip: what was read before the fault stands.
  } finally {
    gz.destroy();
  }
  return w.tar
    ? tarListing(w, 'TAR archive in gzip')
    : { kind: 'gzip file', names: [], total: null };
}

/**
 * The entry names of an archive, or null when the bytes are not a ZIP, a
 * TAR or a gzip. It never throws.
 */
export async function archiveNames(bytes: Buffer): Promise<ArchiveListing | null> {
  try {
    if (bytes.length >= 22 && (u32(bytes, 0) === ZIP_LOCAL || u32(bytes, 0) === ZIP_END)) {
      return zipNames(bytes);
    }
    if (bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b) return await gzipNames(bytes);
    return tarNames(bytes);
  } catch {
    return null;
  }
}

// ─── The text ──────────────────────────────────────────────────────────

/** The line every default text has. */
const DEFAULT_TEXT_NOTE =
  'Mantle has no reader for this file type. This text is the name, the type and the size of the file. It is not the contents of the file.';

/**
 * True for a text {@link defaultFileText} made. The extract stores a file's
 * text on its row; a stored default text must not stand in for a read, or a
 * Reader installed later for the type would never give its own.
 */
export function isDefaultFileText(text: string): boolean {
  return text.startsWith('File name: ') && text.includes(DEFAULT_TEXT_NOTE);
}

/** A size in plain words: "3.2 MB (3355443 bytes)". */
export function sizeInWords(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  if (u === 0) return `${bytes} bytes`;
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[u]} (${bytes} bytes)`;
}

/**
 * The default text of a file no reader takes. `bytes`: null when the file's
 * bytes could not be read; the text then has the name and the type only
 * (and `sizeBytes`, when the caller knows it).
 */
export async function defaultFileText(file: {
  filename: string;
  ext: string;
  mime?: string | null;
  bytes: Buffer | null;
  sizeBytes?: number | null;
}): Promise<string> {
  const listing = file.bytes ? await archiveNames(file.bytes) : null;
  const ext = file.ext ? `.${file.ext}` : 'no extension';
  const mime = file.mime && file.mime !== 'application/octet-stream' ? `, ${file.mime}` : '';
  const type = listing ? `${listing.kind} (${ext}${mime})` : `${ext}${mime}`;
  const size = file.bytes ? file.bytes.length : (file.sizeBytes ?? null);
  const lines = [
    `File name: ${cleanName(file.filename)}`,
    `File type: ${cleanName(type)}`,
    ...(size === null ? [] : [`File size: ${sizeInWords(size)}`]),
    DEFAULT_TEXT_NOTE,
  ];
  if (listing && listing.names.length > 0) {
    const more = listing.total === null ? null : listing.total - listing.names.length;
    lines.push(
      '',
      listing.total === null
        ? 'Entries in the archive (names only):'
        : `Entries in the archive (${listing.total}, names only):`,
      ...listing.names.map((n) => `- ${n}`),
    );
    if (more === null) lines.push('- and more');
    else if (more > 0) lines.push(`- and ${more} more`);
  }
  return lines.join('\n');
}

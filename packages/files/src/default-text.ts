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
 * A gzip (`.gz`, `.tgz`, `.tar.gz`) gets no list: the brain does not inflate
 * outside bytes. Its type line says "gzip file". `.7z` and `.rar` get no
 * list: their directories need a decoder.
 *
 * The file is an outside input, so the work has limits: {@link MAX_NAMES}
 * names, {@link MAX_NAME_CHARS} characters a name (at most
 * {@link MAX_NAME_BYTES} bytes of a name are read; a pax header block is
 * read up to {@link MAX_PAX_BYTES} bytes to find its path),
 * {@link MAX_LIST_CHARS} characters for the list, {@link MAX_HEADERS}
 * headers (TAR) or directory entries (ZIP), and {@link MAX_WALK_MS} for one
 * walk. Every walk has the one clock, and every name is cut to the one size
 * where it is decoded. A broken or hostile archive gives the text with no
 * list, or with the names read before the fault. It never throws.
 */

/** Names one list holds. The rest is one line: "and N more". */
export const MAX_NAMES = 500;
/** Characters of one name. */
export const MAX_NAME_CHARS = 200;
/** Bytes of one name that are decoded; the rest is not read. */
export const MAX_NAME_BYTES = MAX_NAME_CHARS * 4;
/** Characters of all the names of one list together. */
export const MAX_LIST_CHARS = 20_000;
/** TAR headers or ZIP directory entries one walk reads (the count of
 *  entries past this is not known). */
export const MAX_HEADERS = 100_000;
/** Time one walk may take, for every kind of archive. */
export const MAX_WALK_MS = 1_000;

/** The names read from an archive. `total`: the count of entries, or null
 *  when the walk stopped before the end. A gzip has no names: it is not
 *  inflated. */
export type ArchiveListing = {
  kind: 'ZIP archive' | 'TAR archive' | 'gzip file';
  names: string[];
  total: number | null;
};

/** Half of a character pair with no other half: a high one with no low one
 *  after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** One name, safe for one line of text, made of whole characters only (the
 *  cut can fall in the middle of a pair, and Postgres refuses half of one). */
function cleanName(raw: string): string {
  // The cut comes first: the regex never sees a long text.
  const head = raw.slice(0, MAX_NAME_BYTES);
  // eslint-disable-next-line no-control-regex
  const s = head.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const cut = s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS)}...` : s;
  return cut.replace(LONE_SURROGATE, '');
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
    get full() {
      return names.length >= MAX_NAMES || chars >= MAX_LIST_CHARS;
    },
    add(raw: string) {
      count += 1;
      if (this.full) return;
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

function zipNames(b: Buffer, deadline: number): ArchiveListing | null {
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
  // A stored offset that is wrong (bytes were put in front of the zip): the
  // directory is just before the end record.
  if (u32(b, start) !== ZIP_CENTRAL) start = end - size;
  const list = nameList();
  let at = start;
  let walked = 0;
  let late = false;
  while (!list.full && walked < MAX_HEADERS && u32(b, at) === ZIP_CENTRAL && at + 46 <= b.length) {
    if (Date.now() > deadline) {
      late = true;
      break;
    }
    walked += 1;
    const utf8 = (b.readUInt16LE(at + 8) & 0x0800) !== 0;
    const nameLen = b.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    if (at + 46 + nameLen > b.length) break;
    const raw = b.subarray(at + 46, at + 46 + Math.min(nameLen, MAX_NAME_BYTES));
    // Most tools write UTF-8 names, with or without the flag. A name with
    // no flag that is not UTF-8 is latin1. Only the part that is shown is
    // looked at: the cut of a long name can break its last character.
    const text = raw.toString('utf8');
    const isUtf8 = utf8 || !text.slice(0, MAX_NAME_CHARS).includes('\ufffd');
    list.add(isUtf8 ? text : raw.toString('latin1'));
    at = next;
  }
  // The count is the file's own word. One that cannot be true is not shown,
  // and none is when the walk stopped at the entry limit or the time limit.
  const sane =
    !late &&
    walked < MAX_HEADERS &&
    Number.isSafeInteger(total) &&
    total >= list.names.length &&
    total * 46 <= b.length;
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

/** Bytes read of a pax `x` block. More than one name: the block can hold
 *  other records before `path=`. */
export const MAX_PAX_BYTES = 8 * 1024;

/**
 * The names in the 512-byte headers of a TAR, or null when the first block
 * is not a TAR header. The walk stops at the end of the archive (two zero
 * blocks; one is enough here), at a header that is not one, at the header
 * limit or at the time limit.
 */
function tarNames(b: Buffer, deadline: number): ArchiveListing | null {
  const list = nameList();
  let at = 0;
  let headers = 0;
  let longName: string | null = null;
  let ended = false;
  while (at + BLOCK <= b.length) {
    const h = b.subarray(at, at + BLOCK);
    if (h.every((x) => x === 0)) {
      ended = true;
      break;
    }
    if (!tarHeaderOk(h)) break;
    headers += 1;
    if (headers > MAX_HEADERS || Date.now() > deadline) break;
    const size = tarSize(h);
    if (size < 0) break;
    const type = String.fromCharCode(h[156]!);
    const data = at + BLOCK;
    // The data is jumped over.
    at = data + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L' || type === 'x') {
      // The next entry's name is this entry's data. Only its start is read.
      const read = Math.min(size, type === 'x' ? MAX_PAX_BYTES : MAX_NAME_BYTES);
      const text = b.toString('utf8', data, data + read);
      // A GNU long name ends at its first NUL. No regex here: one on a long
      // run of NULs is slow.
      const nul = text.indexOf('\0');
      if (type === 'L') longName = nul < 0 ? text : text.slice(0, nul);
      else longName = paxPath(text);
      continue;
    }
    if (type === 'g' || type === 'K') continue; // no entry of its own
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    // The POSIX magic is "ustar" and a NUL. GNU writes "ustar  ", and its
    // bytes from 345 are times, not a prefix.
    // An empty long name (an entry of size 0, a pax block with no path) is
    // none: the header's own name stands.
    list.add(longName || (prefix && field(h, 257, 6) === 'ustar' ? `${prefix}/${name}` : name));
    longName = null;
  }
  if (headers === 0) return null;
  return { kind: 'TAR archive', names: list.names, total: ended ? list.count : null };
}

/**
 * The entry names of an archive, or null when the bytes are not a ZIP, a
 * TAR or a gzip. It never throws. `deadline`: the one clock of the walk,
 * for every kind of archive (an argument for the tests).
 */
export async function archiveNames(
  bytes: Buffer,
  deadline: number = Date.now() + MAX_WALK_MS,
): Promise<ArchiveListing | null> {
  try {
    if (bytes.length >= 22 && (u32(bytes, 0) === ZIP_LOCAL || u32(bytes, 0) === ZIP_END)) {
      return zipNames(bytes, deadline);
    }
    // A gzip is known by its first two bytes. It is never inflated here.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return { kind: 'gzip file', names: [], total: null };
    }
    return tarNames(bytes, deadline);
  } catch {
    return null;
  }
}

// ─── The text ──────────────────────────────────────────────────────────

/** The line every default text has. */
const DEFAULT_TEXT_NOTE =
  'There is no reader for this file type. This text is the name, the type and the size of the file. It is not the contents of the file.';

/**
 * True for a text {@link defaultFileText} made. The extract stores a file's
 * text on its row; a file's stored default text must not stand in for a
 * read, or a Reader installed later for the type would never give its own.
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

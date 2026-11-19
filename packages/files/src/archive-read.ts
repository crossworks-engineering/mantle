/**
 * Reading the entries of an archive on disk, for the one act that unpacks
 * one: "Extract contents" (./archive-extract.ts, docs/files.md "Archives").
 * Never on upload: an archive stays an archive, and only a person (or an
 * agent for a person) asks for its contents.
 *
 * Three kinds are read, known by their first bytes, never by the name:
 *  - ZIP: the central directory at the end of the file, then each entry's
 *    bytes from its own range of the file (stored or deflated, nothing else);
 *  - TAR: the 512-byte headers and the data between them, in order;
 *  - gzip: inflated as a stream. A TAR inside (`.tar.gz`, `.tgz`) is read as
 *    a TAR; anything else is one file.
 * 7z and RAR are known but not read: no free reader runs here.
 *
 * Every byte comes from the archive file as a stream (no archive is held in
 * memory): a ZIP entry is a read of its own range, inflated through zlib; a
 * TAR is walked chunk by chunk. An entry is never written anywhere by this
 * module: the caller gets each entry's clean path and a stream of its bytes.
 *
 * Refused, and said, never dropped in silence:
 *  - a path that climbs (`..`), an absolute path (`/x`, `C:\x`, `\\host`), a
 *    name with a NUL or a part longer than 255 characters;
 *  - a symbolic or hard link, a device, a FIFO or a socket;
 *  - an encrypted ZIP entry, a ZIP method other than stored or deflated, a
 *    sparse or other TAR entry type this reader does not know;
 *  - an entry past the entry cap, and one whose bytes do not match what the
 *    archive says of them (more bytes than declared: a bomb's lie; another
 *    CRC; a short range): `damaged`.
 * Skipped, and counted: the macOS and Windows folder files (`__MACOSX/`,
 * `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`).
 *
 * The plan (planArchive) reads the whole archive's directory or headers
 * before anything is written: the count of files and their bytes together
 * are checked against the limits there, and an archive past them is refused
 * whole. A ZIP entry is then held to its declared size as it inflates; a
 * TAR's sizes are its headers'.
 *
 * Why here and not in the parser service (docs/parser.md, where every
 * reader of a document runs): this reads no document. It walks fixed binary
 * headers (as ./default-text.ts does for the entry names) and copies bytes
 * through Node's own zlib, as streams held to the caps above, into files the
 * brain writes in its own tree; no parsing library is loaded and no content
 * is decoded. The ZIP guard's caps are mirrored here (archive-read.test.ts
 * holds them equal) rather than imported, as the guard is a reader module.
 */
import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';

/** The kinds of archive known by their first bytes. */
export type ArchiveKind = 'zip' | 'tar' | 'gzip' | '7z' | 'rar';

/** The kinds this box extracts. */
export const EXTRACTABLE_ARCHIVE_KINDS: readonly ArchiveKind[] = ['zip', 'tar', 'gzip'];

/** The name endings of an archive this box extracts. A file is extracted
 *  only when its name AND its first bytes say archive: a .docx is a ZIP
 *  too, and it is a document. */
export const EXTRACTABLE_ARCHIVE_EXTS: readonly string[] = ['zip', 'tar', 'gz', 'tgz'];

/** The name endings of an archive known but not extracted here. */
export const SEALED_ARCHIVE_EXTS: readonly string[] = ['7z', 'rar'];

/** Files of one extraction. The ZIP guard's entry count (100,000) is for a
 *  document's parts; files made in the tree are each read by the upload
 *  pipeline, so the count here is lower. */
export const ARCHIVE_EXTRACT_MAX_FILES = 10_000;

/** Bytes one entry may unpack to: the ZIP guard's part cap (zip-guard.ts
 *  MAX_ZIP_ENTRY_BYTES, held equal by archive-read.test.ts). */
export const ARCHIVE_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
/** Bytes all the files of one archive may unpack to together: the ZIP
 *  guard's file cap (zip-guard.ts MAX_ZIP_TOTAL_BYTES, held equal). */
export const ARCHIVE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** The limits of one extraction. The byte caps are the ZIP guard's own
 *  (zip-guard.ts): an entry and the whole read. */
export type ArchiveLimits = {
  /** Bytes of one entry (the caller lowers it to the box's upload cap). */
  maxEntryBytes: number;
  /** Bytes of the files to write together (TAR: of every entry, since each
   *  is read to pass it). */
  maxTotalBytes: number;
  /** Files to write. */
  maxFiles: number;
};

export const ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxEntryBytes: ARCHIVE_MAX_ENTRY_BYTES,
  maxTotalBytes: ARCHIVE_MAX_TOTAL_BYTES,
  maxFiles: ARCHIVE_EXTRACT_MAX_FILES,
});

/** Why one entry was not written. */
export type EntryRefusal =
  | 'traversal'
  | 'absolute'
  | 'bad-name'
  | 'link'
  | 'device'
  | 'encrypted'
  | 'method'
  | 'unsupported'
  | 'too-large'
  | 'damaged'
  | 'not-written';

/** Why a whole archive was not extracted. */
export class ArchiveRefusedError extends Error {
  constructor(
    readonly reason: 'not-archive' | 'sealed' | 'too-large' | 'too-many' | 'damaged',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveRefusedError';
  }
}

/** One entry's bytes did not match what the archive says of them. */
export class EntryDamagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryDamagedError';
  }
}

// ─── Kinds and names ───────────────────────────────────────────────────

const BLOCK = 512;

/** The kind of an archive by its first bytes (at least 512 for a TAR), or
 *  null. */
export function archiveKindOfHead(head: Buffer): ArchiveKind | null {
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  // An empty ZIP is its end record alone.
  if (head.length >= 22 && head.readUInt32LE(0) === 0x06054b50) return 'zip';
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 6 && head.subarray(0, 6).equals(SEVEN_Z)) return '7z';
  // RAR 4 and 5 share the first six bytes.
  if (head.length >= 6 && head.subarray(0, 6).equals(RAR)) return 'rar';
  if (head.length >= BLOCK && tarHeaderOk(head.subarray(0, BLOCK))) return 'tar';
  return null;
}

const SEVEN_Z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const RAR = Buffer.from('Rar!\x1a\x07', 'latin1');

/** The extension that makes a name an archive's (`tar.gz` counts as `gz`),
 *  or null. */
export function archiveExtOf(filename: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = m ? m[1]!.toLowerCase() : '';
  return EXTRACTABLE_ARCHIVE_EXTS.includes(ext) || SEALED_ARCHIVE_EXTS.includes(ext) ? ext : null;
}

/** A name without its archive ending: `Report 2026.tar.gz` is
 *  `Report 2026`. The name itself when nothing is left. */
export function archiveBaseName(filename: string): string {
  const base = filename
    .trim()
    .replace(/\.(tar\.gz|tar|tgz|gz|zip|7z|rar)$/i, '')
    .trim();
  return base || filename.trim();
}

/** The folder files every archive maker adds: skipped and counted. */
export function isOsMetadataPath(segments: readonly string[]): boolean {
  const last = segments[segments.length - 1] ?? '';
  return (
    segments[0] === '__MACOSX' ||
    last === '.DS_Store' ||
    last.startsWith('._') ||
    last.toLowerCase() === 'thumbs.db' ||
    last.toLowerCase() === 'desktop.ini'
  );
}

/** A name as it is shown in a report: no control characters, at most 200
 *  characters. */
export function shownName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}...` : s || '(no name)';
}

/**
 * The parts of an entry's path, or why it is refused. A backslash is a
 * separator (archives made on Windows), `.` and empty parts go, and the path
 * must stay inside the archive's folder without a `..` anywhere: no
 * normalising, a climb is refused even when it would come back.
 */
export function entrySegments(raw: string): { segments: string[] } | { refused: EntryRefusal } {
  if (raw.includes('\0')) return { refused: 'bad-name' };
  const s = raw.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return { refused: 'absolute' };
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return { refused: 'traversal' };
  if (parts.length === 0) return { refused: 'bad-name' };
  if (parts.some((p) => p.length > 255)) return { refused: 'bad-name' };
  return { segments: parts };
}

// ─── Entries ───────────────────────────────────────────────────────────

/** One entry as the walk gives it. A `file` holds a stream of its bytes,
 *  read on demand: the walk drains what the caller leaves unread. */
export type ArchiveEntry =
  | { type: 'dir'; segments: string[] }
  | {
      type: 'file';
      segments: string[];
      /** Declared bytes (ZIP: the directory's word; TAR: the header's), or
       *  null when nothing declares it (a lone gzip). */
      size: number | null;
      /** The entry's bytes, checked as they come: more than declared, or
       *  another CRC, errors the stream with an EntryDamagedError. */
      open(): Readable;
    }
  | { type: 'refused'; name: string; reason: EntryRefusal }
  | { type: 'skipped'; name: string };

/** What the plan found: the files to write and their bytes, and the
 *  refusals and skips the walk will report. */
export type ArchivePlan = {
  kind: 'zip' | 'tar' | 'gzip';
  files: number;
  bytes: number;
  refused: number;
  skipped: number;
};

/** Read every entry of the archive at `file`, in order, calling `onEntry`
 *  for each and waiting for it. Throws an ArchiveRefusedError for an
 *  archive that cannot be walked. */
export async function walkArchive(
  file: string,
  kind: 'zip' | 'tar' | 'gzip',
  limits: ArchiveLimits,
  onEntry: (entry: ArchiveEntry) => Promise<void>,
): Promise<void> {
  if (kind === 'zip') return walkZip(file, limits, onEntry);
  if (kind === 'tar') return walkTarStream(createReadStream(file), limits, onEntry);
  return walkGzip(file, limits, onEntry);
}

/**
 * Read the whole directory (ZIP) or every header (TAR, gzip) before
 * anything is written: the files and their bytes together. Past the limits
 * the archive is refused whole (an ArchiveRefusedError), and nothing has
 * been written.
 */
export async function planArchive(
  file: string,
  kind: 'zip' | 'tar' | 'gzip',
  limits: ArchiveLimits,
): Promise<ArchivePlan> {
  const plan: ArchivePlan = { kind, files: 0, bytes: 0, refused: 0, skipped: 0 };
  await walkArchive(file, kind, limits, async (e) => {
    if (e.type === 'refused') plan.refused += 1;
    else if (e.type === 'skipped') plan.skipped += 1;
    else if (e.type === 'file') {
      plan.files += 1;
      if (plan.files > limits.maxFiles) {
        throw new ArchiveRefusedError(
          'too-many',
          `The archive holds more than ${limits.maxFiles.toLocaleString('en-US')} files, more than one extraction makes.`,
        );
      }
      if (e.size === null) {
        // A lone gzip: its size is known only by inflating it, here, under
        // the entry cap (the walk's stream errors past it).
        let n = 0;
        try {
          for await (const chunk of e.open()) n += (chunk as Buffer).length;
        } catch (err) {
          if (!(err instanceof EntryDamagedError)) throw err;
          // Past the cap or broken: the write pass refuses it the same way.
          plan.files -= 1;
          plan.refused += 1;
          return;
        }
        plan.bytes += n;
      } else {
        plan.bytes += e.size;
      }
    }
    if (plan.bytes > limits.maxTotalBytes) throw totalRefusal(limits);
  });
  return plan;
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

function totalRefusal(limits: ArchiveLimits): ArchiveRefusedError {
  return new ArchiveRefusedError(
    'too-large',
    `The archive's files unpack to more than ${mb(limits.maxTotalBytes)} together, more than one extraction makes.`,
  );
}

/** A stream that counts what passes, errors past `max` (and below `exact`
 *  at the end when set), and checks a CRC-32 at the end when one is given. */
function checked(opts: { max: number; exact?: number; crc?: number; name: string }): Transform {
  let n = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      n += chunk.length;
      if (n > opts.max) {
        cb(
          new EntryDamagedError(
            opts.exact !== undefined
              ? `${opts.name} unpacks to more bytes than the archive declares for it`
              : `${opts.name} unpacks to more than ${mb(opts.max)}`,
          ),
        );
        return;
      }
      if (opts.crc !== undefined) crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb: TransformCallback) {
      if (opts.exact !== undefined && n !== opts.exact) {
        cb(new EntryDamagedError(`${opts.name} is shorter than the archive declares`));
        return;
      }
      if (opts.crc !== undefined && crc >>> 0 !== opts.crc >>> 0) {
        cb(new EntryDamagedError(`${opts.name} does not match its checksum`));
        return;
      }
      cb();
    },
  });
}

// ─── ZIP ───────────────────────────────────────────────────────────────

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
/** Bytes of a central directory read at most (10,000 files and their
 *  folders take about 1 MB). */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;

type ZipRecord = {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
  /** Unix mode bits when the maker was a Unix one, else null. */
  mode: number | null;
  dosDir: boolean;
};

async function readAt(
  fh: import('node:fs/promises').FileHandle,
  at: number,
  len: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, at);
  return buf.subarray(0, bytesRead);
}

function damaged(what: string): ArchiveRefusedError {
  return new ArchiveRefusedError('damaged', `The archive is damaged: ${what}.`);
}

/** The central directory of the ZIP, and the shift of its offsets (bytes
 *  put in front of the archive). */
async function zipDirectory(
  file: string,
  limits: ArchiveLimits,
): Promise<{ records: ZipRecord[]; shift: number; fileSize: number }> {
  const fileSize = (await stat(file)).size;
  const fh = await open(file, 'r');
  try {
    const tailLen = Math.min(fileSize, 22 + 0xffff + 20);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === ZIP_END) {
        end = i;
        break;
      }
    }
    if (end < 0) throw damaged('it has no end record');
    const endAbs = fileSize - tailLen + end;
    let total = tail.readUInt16LE(end + 10);
    let size = tail.readUInt32LE(end + 12);
    let start = tail.readUInt32LE(end + 16);
    if (end >= 20 && tail.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
      const at = Number(tail.readBigUInt64LE(end - 20 + 8));
      const z = at + 56 <= fileSize ? await readAt(fh, at, 56) : Buffer.alloc(0);
      if (z.length === 56 && z.readUInt32LE(0) === ZIP64_END) {
        total = Number(z.readBigUInt64LE(32));
        size = Number(z.readBigUInt64LE(40));
        start = Number(z.readBigUInt64LE(48));
      }
    }
    // Folders count as entries: twice the files and some, before reading.
    if (!Number.isSafeInteger(total) || total > limits.maxFiles * 2 + 1000) {
      throw new ArchiveRefusedError(
        'too-many',
        `The archive holds more than ${limits.maxFiles.toLocaleString('en-US')} files, more than one extraction makes.`,
      );
    }
    if (!Number.isSafeInteger(size) || size > MAX_CENTRAL_BYTES || size > fileSize) {
      throw damaged('its directory is larger than the file');
    }
    // A stored offset that is wrong (bytes put in front of the zip): the
    // directory is just before the end record.
    let shift = 0;
    let dir = start + size <= fileSize ? await readAt(fh, start, size) : Buffer.alloc(0);
    if (dir.length < 4 || dir.readUInt32LE(0) !== ZIP_CENTRAL) {
      const real = endAbs - size;
      if (real < 0) throw damaged('its directory is not where it says');
      dir = await readAt(fh, real, size);
      shift = real - start;
      if (dir.length < 4 || dir.readUInt32LE(0) !== ZIP_CENTRAL) {
        // An empty archive has an empty directory.
        if (total === 0) return { records: [], shift: 0, fileSize };
        throw damaged('its directory is not where it says');
      }
    }
    const records: ZipRecord[] = [];
    let at = 0;
    while (records.length < total) {
      if (at + 46 > dir.length || dir.readUInt32LE(at) !== ZIP_CENTRAL) {
        throw damaged('its directory ends early');
      }
      const madeBy = dir.readUInt16LE(at + 4);
      const flags = dir.readUInt16LE(at + 8);
      const method = dir.readUInt16LE(at + 10);
      const crc = dir.readUInt32LE(at + 16);
      let compSize = dir.readUInt32LE(at + 20);
      let usize = dir.readUInt32LE(at + 24);
      const nameLen = dir.readUInt16LE(at + 28);
      const extraLen = dir.readUInt16LE(at + 30);
      const commentLen = dir.readUInt16LE(at + 32);
      const ext = dir.readUInt32LE(at + 38);
      let localOffset = dir.readUInt32LE(at + 42);
      const nameEnd = at + 46 + nameLen;
      const next = nameEnd + extraLen + commentLen;
      if (next > dir.length) throw damaged('its directory ends early');
      const rawName = dir.subarray(at + 46, nameEnd);
      // ZIP64 sizes and offset, in this order, for the fields at their max.
      const extra = dir.subarray(nameEnd, nameEnd + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          const take = () => {
            if (p + 8 > e + 4 + len || p + 8 > extra.length)
              throw damaged('a ZIP64 field is short');
            const v = Number(extra.readBigUInt64LE(p));
            p += 8;
            return v;
          };
          if (usize === 0xffffffff) usize = take();
          if (compSize === 0xffffffff) compSize = take();
          if (localOffset === 0xffffffff) localOffset = take();
        }
        e += 4 + len;
      }
      const text = rawName.toString('utf8');
      const name = flags & 0x0800 || !text.includes('\ufffd') ? text : rawName.toString('latin1');
      records.push({
        name,
        flags,
        method,
        crc,
        compSize,
        size: usize,
        localOffset: localOffset + shift,
        mode: madeBy >> 8 === 3 ? (ext >>> 16) & 0xffff : null,
        dosDir: (ext & 0x10) !== 0,
      });
      at = next;
    }
    return { records, shift, fileSize };
  } finally {
    await fh.close().catch(() => {});
  }
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

async function walkZip(
  file: string,
  limits: ArchiveLimits,
  onEntry: (entry: ArchiveEntry) => Promise<void>,
): Promise<void> {
  const { records, fileSize } = await zipDirectory(file, limits);
  const fh = await open(file, 'r');
  try {
    for (const r of records) {
      const name = shownName(r.name);
      const path = entrySegments(r.name);
      if ('refused' in path) {
        await onEntry({ type: 'refused', name, reason: path.refused });
        continue;
      }
      const fmt = r.mode === null ? 0 : r.mode & S_IFMT;
      const isDir = r.name.endsWith('/') || r.name.endsWith('\\') || fmt === S_IFDIR || r.dosDir;
      if (fmt === S_IFLNK) {
        await onEntry({ type: 'refused', name, reason: 'link' });
        continue;
      }
      if (fmt !== 0 && fmt !== S_IFDIR && fmt !== S_IFREG) {
        await onEntry({ type: 'refused', name, reason: 'device' });
        continue;
      }
      if (isDir) {
        if (isOsMetadataPath(path.segments)) continue;
        await onEntry({ type: 'dir', segments: path.segments });
        continue;
      }
      if (isOsMetadataPath(path.segments)) {
        await onEntry({ type: 'skipped', name });
        continue;
      }
      // Bit 0: encrypted; bit 6: strong encryption.
      if (r.flags & 0x0041) {
        await onEntry({ type: 'refused', name, reason: 'encrypted' });
        continue;
      }
      if (r.method !== 0 && r.method !== 8) {
        await onEntry({ type: 'refused', name, reason: 'method' });
        continue;
      }
      if (r.size > limits.maxEntryBytes) {
        await onEntry({ type: 'refused', name, reason: 'too-large' });
        continue;
      }
      // The entry's data: after its local header, whose name and extra
      // lengths are its own (they can differ from the directory's).
      const local = await readAt(fh, r.localOffset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== ZIP_LOCAL) {
        await onEntry({ type: 'refused', name, reason: 'damaged' });
        continue;
      }
      const dataStart = r.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataStart + r.compSize > fileSize || (r.method === 0 && r.compSize !== r.size)) {
        await onEntry({ type: 'refused', name, reason: 'damaged' });
        continue;
      }
      let opened: Readable | null = null;
      await onEntry({
        type: 'file',
        segments: path.segments,
        size: r.size,
        open() {
          const raw =
            r.compSize === 0
              ? Readable.from([])
              : createReadStream(file, { start: dataStart, end: dataStart + r.compSize - 1 });
          const inflate = r.method === 8 ? zlib.createInflateRaw() : null;
          // Held to its declared size as it inflates, and to its CRC.
          const check = checked({ max: r.size, exact: r.size, crc: r.crc, name });
          raw.on('error', (e) => check.destroy(e));
          inflate?.on('error', (e) => check.destroy(damagedOf(e)));
          // A reader that stops (or a refusal) closes the range and the inflate.
          check.on('close', () => {
            raw.destroy();
            inflate?.destroy();
          });
          (inflate ? raw.pipe(inflate) : raw).pipe(check);
          opened = check;
          return check;
        },
      });
      // A range the caller left half read is closed (nothing to drain: the
      // next entry reads its own range).
      (opened as Readable | null)?.destroy();
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

/** A zlib fault is a damaged entry. */
function damagedOf(err: unknown): Error {
  return err instanceof EntryDamagedError
    ? err
    : new EntryDamagedError(`the entry's compressed data is damaged`);
}

// ─── TAR ───────────────────────────────────────────────────────────────

/** Reads exactly what is asked of a stream of chunks. */
class ChunkReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    }
  }
  /** Exactly `n` bytes, or fewer at the end. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(out.length);
    return out;
  }
  /** `n` bytes as chunks, as they come. Ends early at the end of the source
   *  (the caller sees the short count). */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0) {
        if (this.done) return;
        const r = await this.it.next();
        if (r.done) {
          this.done = true;
          return;
        }
        this.buf = r.value;
      }
      const out = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(out.length);
      left -= out.length;
      yield out;
    }
  }
  async skip(n: number): Promise<number> {
    let got = 0;
    for await (const c of this.take(n)) got += c.length;
    return got;
  }
  async close(): Promise<void> {
    await this.it.return?.();
  }
}

const field = (h: Buffer, at: number, len: number) => {
  const raw = h.subarray(at, at + len);
  const nul = raw.indexOf(0);
  return raw.toString('utf8', 0, nul < 0 ? len : nul);
};

/** A header is true when its checksum is. */
function tarHeaderOk(h: Buffer): boolean {
  const want = parseInt(field(h, 148, 8).trim(), 8);
  if (!Number.isFinite(want)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === want;
}

/** The size field: octal text, or a big-endian number when the first bit
 *  is set. -1 for one that is not a size. */
function tarSize(h: Buffer): number {
  if (h[124]! & 0x80) {
    // Base 256: the low 8 of the field's 12 bytes; the 3 above must be 0.
    if (h[125] || h[126] || h[127]) return -1;
    const v = Number(h.readBigUInt64BE(128));
    return Number.isSafeInteger(v) ? v : -1;
  }
  const text = field(h, 124, 12).trim();
  if (!/^[0-7]*$/.test(text)) return -1;
  const n = parseInt(text || '0', 8);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}

/** Bytes of a GNU long name or a pax block read at most: past it the
 *  archive is refused as damaged. */
const MAX_META_BYTES = 64 * 1024;

/** The pax records of a block ("<len> key=value\n"). */
function paxRecords(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < text.length) {
    const sp = text.indexOf(' ', at);
    if (sp < 0) break;
    const len = Number(text.slice(at, sp));
    if (!Number.isSafeInteger(len) || len <= 0 || at + len > text.length) break;
    const rec = text.slice(sp + 1, at + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    at += len;
  }
  return out;
}

const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

/** Walk a TAR given as a stream of chunks (a file, or a gzip inflating). */
async function walkTarStream(
  source: AsyncIterable<Buffer>,
  limits: ArchiveLimits,
  onEntry: (entry: ArchiveEntry) => Promise<void>,
  first?: Buffer,
): Promise<void> {
  const r = new ChunkReader(prefixed(first, source));
  let headers = 0;
  let longName: string | null = null;
  let pax = new Map<string, string>();
  // Every entry's bytes count (each is read to pass it): the whole read is
  // bounded by the total cap and the header cap.
  let bytes = 0;
  try {
    for (;;) {
      const h = await r.read(BLOCK);
      if (h.length === 0) break; // no end blocks: the end of the file
      if (h.length < BLOCK) throw damaged('it ends inside a header');
      if (h.every((x) => x === 0)) break;
      if (!tarHeaderOk(h)) throw damaged('a header is not a TAR header');
      headers += 1;
      if (headers > limits.maxFiles * 4 + 64) {
        throw new ArchiveRefusedError(
          'too-many',
          `The archive holds more than ${limits.maxFiles.toLocaleString('en-US')} files, more than one extraction makes.`,
        );
      }
      const type = String.fromCharCode(h[156]!);
      let size = tarSize(h);
      if (size < 0) throw damaged('a header has no size');
      // A pax size stands for the header's (a file past 8 GB).
      const paxSize = pax.get('size');
      if (paxSize !== undefined && !['x', 'g', 'L', 'K'].includes(type)) {
        const n = Number(paxSize);
        if (!Number.isSafeInteger(n) || n < 0) throw damaged('a pax size is not a size');
        size = n;
      }
      if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
        if (size > MAX_META_BYTES) throw damaged('a long name or pax block is too long');
        const data = await r.read(size);
        if (data.length < size) throw damaged('it ends inside an entry');
        await r.skip(pad(size));
        if (type === 'L') {
          const t = data.toString('utf8');
          const nul = t.indexOf('\0');
          longName = nul < 0 ? t : t.slice(0, nul);
        } else if (type === 'x') {
          pax = paxRecords(data.toString('utf8'));
        }
        // K (a long link target) and g (global records) name no entry.
        continue;
      }
      bytes += size;
      if (bytes > limits.maxTotalBytes) throw totalRefusal(limits);

      const prefix = field(h, 345, 155);
      const own =
        prefix && field(h, 257, 6) === 'ustar' ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100);
      const rawName = pax.get('path') || longName || own;
      longName = null;
      pax = new Map();
      const name = shownName(rawName);
      const path = entrySegments(rawName);

      let reported: ArchiveEntry | null = null;
      let fileSize = -1;
      if ('refused' in path) reported = { type: 'refused', name, reason: path.refused };
      else if (type === '1' || type === '2') reported = { type: 'refused', name, reason: 'link' };
      else if (type === '3' || type === '4' || type === '6') {
        reported = { type: 'refused', name, reason: 'device' };
      } else if (type === '5') {
        if (!isOsMetadataPath(path.segments)) reported = { type: 'dir', segments: path.segments };
      } else if (type === '0' || type === '\0' || type === '7') {
        if (isOsMetadataPath(path.segments)) reported = { type: 'skipped', name };
        else if (size > limits.maxEntryBytes)
          reported = { type: 'refused', name, reason: 'too-large' };
        else fileSize = size;
      } else {
        // S (sparse), V (a volume label), M (a multi-volume part), D, ...
        reported = { type: 'refused', name, reason: 'unsupported' };
      }

      let read = 0;
      let body: Readable | null = null;
      if (fileSize >= 0) {
        let opened = false;
        await onEntry({
          type: 'file',
          segments: (path as { segments: string[] }).segments,
          size: fileSize,
          open() {
            if (opened) throw new Error('an entry is read once');
            opened = true;
            const check = checked({ max: fileSize, exact: fileSize, name });
            const from = Readable.from(
              (async function* () {
                for await (const c of r.take(fileSize - read)) {
                  read += c.length;
                  yield c;
                }
              })(),
            );
            body = from;
            from.on('error', (e) => check.destroy(e));
            check.on('close', () => from.destroy());
            return from.pipe(check);
          },
        });
        // A reader that stopped early (a refusal, a failed write): its
        // stream is closed and its last read of the archive has ended
        // before the walk reads on, so the count of what it took is final.
        const opened_ = body as Readable | null;
        if (opened_) {
          if (!opened_.destroyed) opened_.destroy();
          if (!opened_.closed) await new Promise((done) => opened_.once('close', done));
        }
      } else if (reported) {
        await onEntry(reported);
      }
      // What the caller left unread is read past, and the block padding.
      const left = size - read;
      if (left > 0 && (await r.skip(left)) < left) throw damaged('it ends inside an entry');
      await r.skip(pad(size));
    }
  } finally {
    await r.close().catch(() => {});
  }
}

async function* prefixed(
  first: Buffer | undefined,
  source: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  if (first && first.length > 0) yield first;
  for await (const c of source) yield c as Buffer;
}

// ─── gzip ──────────────────────────────────────────────────────────────

/**
 * A gzip: a TAR inside is walked as one; anything else is one file, the
 * archive's name without `.gz`, its size known only by inflating it (held
 * to the entry cap as it inflates). The inflate as a whole is held to the
 * total cap and some room for headers: a stream that inflates past what
 * its TAR declares is stopped.
 */
async function walkGzip(
  file: string,
  limits: ArchiveLimits,
  onEntry: (entry: ArchiveEntry) => Promise<void>,
): Promise<void> {
  const raw = createReadStream(file);
  const gunzip = zlib.createGunzip();
  const room = limits.maxTotalBytes + (limits.maxFiles * 4 + 64) * 2 * BLOCK + 4 * MAX_META_BYTES;
  const meter = checked({ max: room, name: 'The archive' });
  raw.on('error', (e) => gunzip.destroy(e));
  gunzip.on('error', (e) => meter.destroy(damagedOf(e)));
  const inflated = raw.pipe(gunzip).pipe(meter);
  try {
    const r = new ChunkReader(inflated as AsyncIterable<Buffer>);
    const head = await r.read(BLOCK);
    if (head.length === BLOCK && tarHeaderOk(head)) {
      // The reader holds the rest of the stream: walk on from it.
      await walkTarStream(rest(r), limits, onEntry, head);
      return;
    }
    let opened = false;
    await onEntry({
      type: 'file',
      // Named by the caller (the archive's own name without `.gz`).
      segments: [],
      size: null,
      open() {
        if (opened) throw new Error('an entry is read once');
        opened = true;
        const check = checked({ max: limits.maxEntryBytes, name: 'The file in the gzip' });
        const body = Readable.from(prefixed(head, rest(r)));
        body.on('error', (e) => check.destroy(e instanceof EntryDamagedError ? e : damagedOf(e)));
        return body.pipe(check);
      },
    });
  } catch (err) {
    // A zlib fault met by the walk itself is a damaged archive.
    if (err instanceof EntryDamagedError) throw damaged(err.message);
    throw err;
  } finally {
    inflated.destroy();
    gunzip.destroy();
    raw.destroy();
  }
}

/** The bytes a reader has not given yet, as a stream of chunks. */
async function* rest(r: ChunkReader): AsyncGenerator<Buffer> {
  for (;;) {
    const c = await r.read(64 * 1024);
    if (c.length === 0) return;
    yield c;
  }
}

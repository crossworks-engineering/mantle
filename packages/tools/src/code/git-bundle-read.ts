/**
 * Read a git bundle someone else made: the files of one commit, and whether
 * a given commit is in that commit's history. The input is untrusted (an
 * outside agent's `git bundle create`), so every step has a limit: the
 * header, the object count, each object's size, the delta depth, and the
 * total bytes inflated or rebuilt (a zlib or delta bomb stops there). The
 * pack's SHA-1 trailer is checked, and each object is found by the id of
 * its own content, never by what the header says.
 *
 * A pack (git's gitformat-pack.txt) is entries back to back: a type and
 * size, then zlib data. A delta entry (OFS_DELTA by offset, REF_DELTA by
 * id) rebuilds an object from another one with copy and insert steps.
 * Objects are not kept inflated: each is inflated again when it is needed,
 * with a small cache, so memory holds the bundle and the cache.
 *
 * A tree may hold only plain files (mode 100644 or 100755) and folders:
 * a symlink, a submodule, another mode, a name git would refuse, or a file
 * that is not UTF-8 text fails the read, naming the path.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { badGitPart } from './git-bundle';
import { badNewPath } from './target-ref';

export type BundleReadLimits = {
  /** Objects the pack may hold. */
  maxObjects: number;
  /** The largest object, inflated or rebuilt. */
  maxObjectBytes: number;
  /** Bytes inflated and rebuilt in all (the work; a bomb stops here). */
  maxWorkBytes: number;
  /** The longest delta chain. */
  maxDeltaDepth: number;
  /** Files the commit's tree may hold. */
  maxFiles: number;
  /** The largest file. */
  maxFileBytes: number;
  /** Folders deep. */
  maxTreeDepth: number;
  /** The longest path, in bytes (a name is at most 255). */
  maxPathBytes: number;
};

export const BUNDLE_READ_LIMITS: BundleReadLimits = {
  // An app's history: a few objects a version, git export's 5000 versions.
  maxObjects: 50_000,
  // An app file is at most 256 KB; a tree or commit is small.
  maxObjectBytes: 1024 * 1024,
  maxWorkBytes: 256 * 1024 * 1024,
  maxDeltaDepth: 50,
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxTreeDepth: 32,
  maxPathBytes: 256,
};

/** A bundle that cannot be read, or that the read refuses: the message
 *  says why and what to do. */
export class BundleReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleReadError';
  }
}

const fail = (why: string): never => {
  throw new BundleReadError(why);
};

const HEX40 = /^[0-9a-f]{40}$/;
const TYPE_NAME = ['', 'commit', 'tree', 'blob', 'tag'] as const;
const OFS_DELTA = 6;
const REF_DELTA = 7;
/** Resolved objects kept inflated, by bytes. */
const CACHE_BYTES = 32 * 1024 * 1024;
/** The header's most bytes and refs, and a ref name's most bytes. */
const HEADER_MAX_BYTES = 1024 * 1024;
const HEADER_MAX_REFS = 10_000;
const REF_MAX_BYTES = 255;
/** A name in a tree: git's and every file system's most bytes. */
const NAME_MAX_BYTES = 255;

/** True when the text holds a C0 control character or DEL. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** The bundle's header: its refs (name to id) and where the pack starts. */
export function readBundleHeader(buf: Buffer): { refs: Map<string, string>; packAt: number } {
  const end = buf.subarray(0, HEADER_MAX_BYTES).indexOf('\n\n');
  if (end < 0) fail('the file is not a git bundle (no header end): make it with git bundle create');
  const lines = buf.subarray(0, end).toString('utf8').split('\n');
  const sig = lines.shift();
  if (sig !== '# v2 git bundle' && sig !== '# v3 git bundle') {
    fail('the file is not a v2 or v3 git bundle: make it with git bundle create app.bundle main');
  }
  const refs = new Map<string, string>();
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (line !== '@object-format=sha1') {
        fail(`the bundle asks for '${line.slice(0, 60)}': only a whole SHA-1 bundle is read`);
      }
      continue;
    }
    if (line.startsWith('-')) {
      fail(
        'the bundle needs commits it does not hold (a range like v3..main): bundle the whole branch, git bundle create app.bundle main',
      );
    }
    const sp = line.indexOf(' ');
    const id = line.slice(0, sp);
    const name = line.slice(sp + 1);
    if (sp !== 40 || !HEX40.test(id) || !name)
      fail('the bundle header has a line that is not a ref');
    // A ref's name reaches the caller: short and plain.
    if (Buffer.byteLength(name) > REF_MAX_BYTES || hasControl(name)) {
      fail('the bundle has a ref name that is too long or not plain: bundle one branch, e.g. main');
    }
    if (refs.size >= HEADER_MAX_REFS) fail('the bundle has too many refs: bundle one branch');
    refs.set(name, id);
  }
  return { refs, packAt: end + 2 };
}

/** One pack entry, where it sits; its id and type once known. */
type Entry = {
  at: number;
  /** Where its zlib data starts. */
  dataAt: number;
  /** 1-4, or OFS_DELTA / REF_DELTA. */
  kind: number;
  /** The inflated size of the entry's data (the delta, for a delta). */
  size: number;
  /** Its zlib data's length, once indexed. */
  zlen?: number;
  base?: number | string;
  /** The object's type (1-4) and id, once rebuilt. */
  type?: number;
  id?: string;
  depth?: number;
};

/** A pack's objects, found by id; each rebuilt on demand within limits. */
export class PackReader {
  private readonly entries: Entry[] = [];
  private readonly byAt = new Map<number, Entry>();
  private readonly byId = new Map<string, Entry>();
  private readonly cache = new Map<number, Buffer>();
  private cached = 0;
  private work = 0;
  private lastYield = Date.now();

  private constructor(
    private readonly pack: Buffer,
    private readonly limits: BundleReadLimits,
  ) {}

  /** Read every entry's place, then rebuild each object once for its id. */
  static async open(pack: Buffer, limits: BundleReadLimits): Promise<PackReader> {
    const r = new PackReader(pack, limits);
    await r.index();
    return r;
  }

  /** The object `id` (type and content), or null when the pack lacks it. */
  async get(id: string): Promise<{ type: string; body: Buffer } | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    const body = await this.body(e, 0);
    return { type: TYPE_NAME[e.type!]!, body };
  }

  private charge(bytes: number): void {
    this.work += bytes;
    if (this.work > this.limits.maxWorkBytes) {
      fail(
        `the bundle takes more than ${this.limits.maxWorkBytes / 1024 / 1024} MB to unpack: bundle less history (git bundle create app.bundle main after a squash), or copy the files with app_source_set`,
      );
    }
  }

  /** Let the event loop run between objects (and between the steps of a
   *  caller's walk). */
  async breathe(): Promise<void> {
    if (Date.now() - this.lastYield < 10) return;
    await new Promise((r) => setImmediate(r));
    this.lastYield = Date.now();
  }

  private async index(): Promise<void> {
    const p = this.pack;
    if (p.length < 32 || p.toString('latin1', 0, 4) !== 'PACK') fail('the bundle holds no pack');
    const version = p.readUInt32BE(4);
    if (version !== 2 && version !== 3) fail(`the bundle's pack is version ${version}, not 2 or 3`);
    const count = p.readUInt32BE(8);
    if (count > this.limits.maxObjects) {
      fail(
        `the bundle has ${count} objects, past the ${this.limits.maxObjects} read: bundle less history`,
      );
    }
    const end = p.length - 20;
    const sum = createHash('sha1').update(p.subarray(0, end)).digest();
    if (!sum.equals(p.subarray(end)))
      fail('the bundle is damaged (its pack checksum is wrong): make it again');
    let at = 12;
    for (let i = 0; i < count; i++) {
      if (at >= end) fail('the bundle is damaged (the pack ends early): make it again');
      const e = this.head(at, end);
      const { buffer, used } = this.inflate(e, end);
      if (buffer.length !== e.size)
        fail('the bundle is damaged (an object is not the size it says)');
      at = e.dataAt + used;
      e.zlen = used;
      this.entries.push(e);
      this.byAt.set(e.at, e);
      if (e.kind < OFS_DELTA) {
        e.type = e.kind;
        e.depth = 0;
        this.name(e, buffer);
      }
      await this.breathe();
    }
    if (at !== end) fail('the bundle is damaged (bytes after the last object): make it again');
    // Deltas: rebuild each whose base is known, until none is left or none moves.
    let left = this.entries.filter((e) => e.id === undefined);
    while (left.length) {
      const next: Entry[] = [];
      for (const e of left) {
        const base = typeof e.base === 'number' ? this.byAt.get(e.base) : this.byId.get(e.base!);
        if (!base || base.id === undefined) {
          next.push(e);
          continue;
        }
        e.type = base.type;
        e.depth = base.depth! + 1;
        if (e.depth > this.limits.maxDeltaDepth) {
          fail(
            `the bundle has a delta chain past ${this.limits.maxDeltaDepth}: make it with git bundle create (default depth)`,
          );
        }
        this.name(e, await this.body(e, 0));
        await this.breathe();
      }
      if (next.length === left.length) {
        fail(
          'the bundle has a delta whose base it does not hold: bundle the whole branch, git bundle create app.bundle main',
        );
      }
      left = next;
    }
  }

  /** An entry's head at `at`: type, size, and a delta's base. */
  private head(at: number, end: number): Entry {
    const p = this.pack;
    let i = at;
    let c = p[i++]!;
    const kind = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      if (i >= end || shift > 28) fail('the bundle is damaged (an object size is too long)');
      c = p[i++]!;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (kind === 0 || kind === 5) fail(`the bundle has an object of an unknown type (${kind})`);
    if (size > this.limits.maxObjectBytes) {
      fail(
        `the bundle has an object past ${this.limits.maxObjectBytes / 1024 / 1024} MB: an app file is at most 256 KB`,
      );
    }
    const e: Entry = { at, dataAt: 0, kind, size };
    if (kind === OFS_DELTA) {
      c = p[i++]!;
      let back = c & 0x7f;
      while (c & 0x80) {
        if (i >= end || back > 2 ** 40) fail('the bundle is damaged (a delta offset is too long)');
        c = p[i++]!;
        back = (back + 1) * 128 + (c & 0x7f);
      }
      const base = at - back;
      if (back <= 0 || base < 12 || !this.byAt.has(base))
        fail('the bundle is damaged (a delta names no object before it)');
      e.base = base;
    } else if (kind === REF_DELTA) {
      if (i + 20 > end) fail('the bundle is damaged (the pack ends early)');
      e.base = p.toString('hex', i, i + 20);
      i += 20;
    }
    e.dataAt = i;
    return e;
  }

  /** Inflate an entry's data: at most its size, and how many bytes it
   *  used. Once indexed, only its own zlib bytes are read. The work counts
   *  both sides (padding in a zlib stream is work too). */
  private inflate(e: Entry, end = this.pack.length - 20): { buffer: Buffer; used: number } {
    let r: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      const stop = e.zlen === undefined ? end : e.dataAt + e.zlen;
      r = inflateSync(this.pack.subarray(e.dataAt, stop), {
        info: true,
        maxOutputLength: Math.max(e.size, 1),
      }) as unknown as typeof r;
    } catch {
      return fail('the bundle is damaged (an object does not inflate to the size it says)');
    }
    this.charge(e.size + r.engine.bytesWritten);
    return { buffer: r.buffer, used: r.engine.bytesWritten };
  }

  /** Give a rebuilt object its id; the first of an id wins. */
  private name(e: Entry, body: Buffer): void {
    e.id = createHash('sha1')
      .update(`${TYPE_NAME[e.type!]} ${body.length}\0`)
      .update(body)
      .digest('hex');
    if (!this.byId.has(e.id)) this.byId.set(e.id, e);
  }

  /** An entry's object, rebuilt through its delta chain. */
  private async body(e: Entry, depth: number): Promise<Buffer> {
    const hit = this.cache.get(e.at);
    if (hit) return hit;
    if (depth > this.limits.maxDeltaDepth) fail('the bundle has a delta chain that is too long');
    let out: Buffer;
    if (e.kind === OFS_DELTA || e.kind === REF_DELTA) {
      const base = typeof e.base === 'number' ? this.byAt.get(e.base) : this.byId.get(e.base!);
      if (!base) fail('the bundle has a delta whose base it does not hold');
      // The base first: a chain holds one delta at a time, not one a level.
      const from = await this.body(base!, depth + 1);
      out = applyDelta(from, this.inflate(e).buffer, this.limits.maxObjectBytes);
      this.charge(out.length);
    } else {
      out = this.inflate(e).buffer;
    }
    this.keep(e.at, out);
    return out;
  }

  private keep(at: number, body: Buffer): void {
    if (body.length > CACHE_BYTES / 4) return;
    this.cache.set(at, body);
    this.cached += body.length;
    for (const [k, v] of this.cache) {
      if (this.cached <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cached -= v.length;
    }
  }
}

/** A delta's size field (7 bits a byte, low first). */
function deltaSize(d: Buffer, at: { i: number }): number {
  let size = 0;
  let shift = 0;
  let c: number;
  do {
    if (at.i >= d.length || shift > 28) fail('the bundle is damaged (a delta size is too long)');
    c = d[at.i++]!;
    size += (c & 0x7f) * 2 ** shift;
    shift += 7;
  } while (c & 0x80);
  return size;
}

/** Rebuild an object from its base and a delta; every copy is checked to
 *  stay inside the base and the result. */
export function applyDelta(base: Buffer, d: Buffer, max: number): Buffer {
  const at = { i: 0 };
  if (deltaSize(d, at) !== base.length) fail('the bundle is damaged (a delta is for another base)');
  const size = deltaSize(d, at);
  if (size > max) fail(`the bundle has an object past ${max / 1024 / 1024} MB`);
  const out = Buffer.allocUnsafe(size);
  let o = 0;
  while (at.i < d.length) {
    const op = d[at.i++]!;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off += d[at.i++]! * 2 ** (8 * b);
      for (let b = 0; b < 3; b++) if (op & (1 << (4 + b))) len += d[at.i++]! * 2 ** (8 * b);
      if (at.i > d.length) fail('the bundle is damaged (a delta ends early)');
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > size)
        fail('the bundle is damaged (a delta copies outside its base)');
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op > 0) {
      if (at.i + op > d.length || o + op > size)
        fail('the bundle is damaged (a delta inserts past its end)');
      d.copy(out, o, at.i, at.i + op);
      at.i += op;
      o += op;
    } else {
      fail('the bundle is damaged (a delta has a reserved step)');
    }
  }
  if (o !== size) fail('the bundle is damaged (a delta builds the wrong size)');
  return out;
}

/** A commit's tree and parents. */
function parseCommit(body: Buffer): { tree: string; parents: string[] } {
  const text = body.toString('latin1', 0, Math.min(body.length, 64 * 1024));
  const head = text.split('\n\n', 1)[0]!.split('\n');
  const tree = /^tree ([0-9a-f]{40})$/.exec(head[0] ?? '')?.[1];
  if (!tree) fail('the bundle has a commit with no tree');
  const parents: string[] = [];
  for (const line of head.slice(1)) {
    const m = /^parent ([0-9a-f]{40})$/.exec(line);
    if (m) parents.push(m[1]!);
    else break;
  }
  return { tree: tree!, parents };
}

/** The ref a read takes: the one named (a branch or a full ref), else HEAD,
 *  main, or the one branch. */
export function pickRef(refs: Map<string, string>, want?: string): { ref: string; id: string } {
  if (want) {
    for (const name of [want, `refs/heads/${want}`, `refs/tags/${want}`]) {
      const id = refs.get(name);
      if (id) return { ref: name, id };
    }
    fail(
      `the bundle has no ref '${want}': it has ${[...refs.keys()].slice(0, 10).join(', ') || 'none'}`,
    );
  }
  for (const name of ['HEAD', 'refs/heads/main']) {
    const id = refs.get(name);
    if (id) return { ref: name, id };
  }
  const heads = [...refs.keys()].filter((r) => r.startsWith('refs/heads/'));
  if (heads.length === 1) return { ref: heads[0]!, id: refs.get(heads[0]!)! };
  return fail(
    `the bundle has no HEAD or main and ${heads.length} branches: name one with branch (it has ${[...refs.keys()].slice(0, 10).join(', ') || 'none'})`,
  );
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The bundle read: the commit taken, its files, and whether `base` is in
 *  its history (the commit itself or an ancestor). */
export type BundleTree = {
  ref: string;
  head: string;
  files: Record<string, string>;
  hasBase: boolean;
};

/**
 * Read bundle `buf`: the commit of `branch` (or the default ref), each of
 * its files as UTF-8 text, and whether commit `base` is in its history.
 * Throws BundleReadError on anything the limits or the file rules refuse.
 */
export async function readBundleTree(
  buf: Buffer,
  opts: { base: string; branch?: string; limits?: BundleReadLimits },
): Promise<BundleTree> {
  const limits = opts.limits ?? BUNDLE_READ_LIMITS;
  const { refs, packAt } = readBundleHeader(buf);
  const { ref, id: head } = pickRef(refs, opts.branch);
  const pack = await PackReader.open(buf.subarray(packAt), limits);
  const tip = await pack.get(head);
  if (!tip) fail(`the bundle's ${ref} names a commit it does not hold: make it again`);
  if (tip!.type !== 'commit') fail(`the bundle's ${ref} is a ${tip!.type}, not a commit`);

  // The base: the tip or an ancestor, each commit seen once.
  let hasBase = false;
  const seen = new Set<string>([head]);
  const queue = [head];
  for (let q = 0; q < queue.length; q++) {
    const id = queue[q]!;
    if (id === opts.base) {
      hasBase = true;
      break;
    }
    await pack.breathe();
    const c = await pack.get(id);
    if (!c || c.type !== 'commit') continue;
    for (const p of parseCommit(c.body).parents) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }

  const files: Record<string, string> = {};
  let count = 0;
  // Folder entries too: one small tree named many times is work, not files.
  let entries = 0;
  const walk = async (treeId: string, prefix: string, depth: number): Promise<void> => {
    if (depth > limits.maxTreeDepth)
      fail(`the bundle's tree is more than ${limits.maxTreeDepth} folders deep`);
    await pack.breathe();
    const t = await pack.get(treeId);
    if (!t || t.type !== 'tree')
      fail(`the bundle lacks the folder ${prefix || '/'}: make it again`);
    const body = t!.body;
    const names = new Set<string>();
    let i = 0;
    while (i < body.length) {
      const sp = body.indexOf(0x20, i);
      const nul = sp < 0 ? -1 : body.indexOf(0, sp);
      if (sp < 0 || nul < 0 || nul + 21 > body.length) fail('the bundle has a damaged folder');
      const mode = body.toString('latin1', i, sp);
      // Sizes first: a long name is refused before it is decoded or joined.
      const nameBytes = nul - sp - 1;
      if (
        nameBytes > NAME_MAX_BYTES ||
        Buffer.byteLength(prefix) + nameBytes > limits.maxPathBytes
      ) {
        fail(
          `a name in ${prefix.slice(0, 100) || 'the top folder'} is too long (a path is at most ${limits.maxPathBytes} bytes)`,
        );
      }
      let name: string;
      try {
        name = utf8.decode(body.subarray(sp + 1, nul));
      } catch {
        return fail(`a name in ${prefix || 'the top folder'} is not UTF-8`);
      }
      const id = body.toString('hex', nul + 1, nul + 21);
      i = nul + 21;
      if (++entries > limits.maxFiles * 20)
        fail('the commit has too many folders: an app holds a few files');
      const path = prefix + name;
      const why = badNewPath(path) ?? (name.includes('/') ? 'a / in a name' : badGitPart(name));
      if (why) fail(`the bundle has '${path.slice(0, 200)}', which may not be imported: ${why}`);
      if (names.has(name)) fail(`the bundle has '${path}' twice in one folder`);
      names.add(name);
      if (mode === '40000') {
        await walk(id, `${path}/`, depth + 1);
      } else if (mode === '100644' || mode === '100755') {
        if (++count > limits.maxFiles)
          fail(`the commit has more than ${limits.maxFiles} files, the most an app may hold`);
        const blob = await pack.get(id);
        if (!blob || blob.type !== 'blob') fail(`the bundle lacks the file ${path}: make it again`);
        if (blob!.body.length > limits.maxFileBytes) {
          fail(
            `${path} is ${Math.ceil(blob!.body.length / 1024)} KB, past the ${limits.maxFileBytes / 1024} KB an app file may be`,
          );
        }
        let text: string;
        try {
          text = utf8.decode(blob!.body);
        } catch {
          return fail(`${path} is not UTF-8 text: an app holds source files only`);
        }
        if (text.includes('\0'))
          fail(`${path} is not text (it holds a NUL): an app holds source files only`);
        files[path] = text;
      } else if (mode === '120000') {
        fail(`${path} is a symlink: an app holds plain files only`);
      } else if (mode === '160000') {
        fail(`${path} is a submodule: an app holds plain files only`);
      } else {
        fail(
          `${path} has the file mode ${mode.slice(0, 10)}: an app holds plain files (100644) and folders only`,
        );
      }
    }
  };
  await walk(parseCommit(tip!.body).tree, '', 0);
  return { ref, head, files, hasBase };
}

/**
 * A git bundle of an app's versions, written in TypeScript: no `git` binary
 * on the box (the images do not all ship one) and no library. A bundle is a
 * text header (the refs) and one pack; a pack is each object, zlib-deflated
 * with a short type-and-size header, and a SHA-1 trailer (git's
 * Documentation/gitformat-bundle.txt and gitformat-pack.txt). Every object is
 * whole (no deltas): git takes that, and the trees of an app (at most 50
 * files) are small. A blob two versions share is written once.
 *
 * `git clone app.bundle` then gives the version line as commits: log, diff,
 * blame and bisect work on the outside agent's own machine. Nothing here
 * reads a database; the caller hands in the versions, one at a time.
 *
 * On disk, not in memory: each new object is deflated (off the event loop)
 * and appended to a work file; `finish` writes the bundle file from it with
 * one running SHA-1. The process holds one version's files and the ids.
 *
 * Deterministic: the same versions give the same commit ids, every export.
 * Every input to an id is fixed: paths sorted (git's order), one file mode
 * (100644), the author and committer one name with no email, the time the
 * caller gives in +0000, the message as given, each commit on the one before.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { deflate as deflateCb } from 'node:zlib';
import { badNewPath, normCodePath } from './target-ref';

const deflate = promisify(deflateCb);

/** One commit: a version's files and who made it, when. */
export type BundleCommit = {
  files: Readonly<Record<string, string>>;
  /** The author name: a role name or a login id, never an email. */
  author: string;
  /** Seconds since the epoch. */
  time: number;
  message: string;
  /** Text that may change later (a note, a login): kept in git notes
   *  (refs/notes/commits), outside the commit, so it never moves an id. */
  gitNote?: string;
};

/** The ref the notes are on (what `git log` shows by default). */
export const NOTES_REF = 'refs/notes/commits';

export type BundleResult = {
  /** The bundle file's size. */
  bytes: number;
  /** The tip commit's id (refs/heads/main and HEAD). */
  head: string;
  commits: number;
  /** Paths left out of a commit: a name git may not hold (a `.git` part,
   *  `..`), one a folder of the same name took, or a second key of a path. */
  skipped: { commit: number; path: string; why: string }[];
  /** All paths left out (`skipped` keeps the first SKIPPED_KEPT). */
  skippedCount: number;
};

/** The largest git bundle app_export writes (on disk while it is made,
 *  then stored as a file) and app_source_from_bundle reads. */
export const GIT_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

/** The skipped paths a result lists by name. */
export const SKIPPED_KEPT = 20;

/** The branch the bundle carries. */
export const BUNDLE_BRANCH = 'main';

type ObjType = 'commit' | 'tree' | 'blob';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3 };

/** A folder of a commit's tree: blob ids by name, folders by name. */
type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };

const emptyDir = (): Dir => ({ files: new Map(), dirs: new Map() });

/** Code points HFS+ ignores in a name (git's is_hfs_dotgit drops them
 *  before it compares). */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Why git may not hold a path part, or null: what git's own checks refuse
 * on a checkout or an fsck'd clone (verify_path, is_ntfs_dotgit,
 * is_hfs_dotgit), so the bundle always clones. `.git` in any case, with the
 * code points HFS+ drops, the dots or spaces Windows drops, a `:` stream
 * name, or as its 8.3 short name `git~1`; and `.gitmodules` the same ways
 * (an app has no submodule).
 */
export function badGitPart(part: string): string | null {
  if (part.includes(':')) return "a ':' in a name";
  const plain = part
    .replace(HFS_IGNORED, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
  if (plain === '.git' || plain === 'git~1') return "a '.git' part";
  // The NTFS short names include git's hashed ones (gi7eba~N, gi7d29~N).
  if (plain === '.gitmodules' || /^(gitmod|gi7eba)~\d$/.test(plain)) {
    return "a '.gitmodules' file";
  }
  // git's fallback 8.3 names: 8 characters, a prefix of the hashed name,
  // `~` and a number (is_ntfs_dot_generic).
  const short = plain.length === 8 ? /^([^~]{0,6})~[1-9]\d*$/.exec(plain) : null;
  if (short && ('gi7eba'.startsWith(short[1]!) || 'gi7d29'.startsWith(short[1]!))) {
    return "a '.gitmodules' or '.gitattributes' short name";
  }
  // fsck reads .gitattributes too (a line too long fails a checked clone);
  // an app's build has no use for one.
  if (plain === '.gitattributes' || /^(gitatt|gi7d29)~\d$/.test(plain)) {
    return "a '.gitattributes' file";
  }
  return null;
}

/** A bundle path's most bytes, and a name's (git's and file systems'). */
export const BUNDLE_PATH_MAX_BYTES = 256;
export const BUNDLE_NAME_MAX_BYTES = 255;

/**
 * Why a path may not travel in a bundle, either way, or null: the code
 * tools' rule (badNewPath), the names git refuses (badGitPart), no space at
 * the start or end of a name (the code tools would trim it to another
 * file), and the lengths. The export leaves such a path out and the import
 * refuses it, so the two agree: what an export skips, an import keeps from
 * the live tree.
 */
export function badBundlePath(path: string): string | null {
  const why = badNewPath(path);
  if (why) return why;
  if (Buffer.byteLength(path) > BUNDLE_PATH_MAX_BYTES) {
    return `a path past ${BUNDLE_PATH_MAX_BYTES} bytes`;
  }
  for (const part of path.split('/')) {
    if (part !== part.trim()) return 'a space at the start or end of a name';
    if (Buffer.byteLength(part) > BUNDLE_NAME_MAX_BYTES) {
      return `a name past ${BUNDLE_NAME_MAX_BYTES} bytes`;
    }
    const git = badGitPart(part);
    if (git) return git;
  }
  return null;
}

/** A one-line field of a commit (author): no control character, no `<>`. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it removes or refuses
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim() || 'unknown';
}

export class GitBundleWriter {
  private readonly ids = new Set<string>();
  private work: FileHandle | null = null;
  private packed = 0;
  private parent: string | null = null;
  private count = 0;
  private readonly skipped: BundleResult['skipped'] = [];
  private skippedCount = 0;
  /** The previous version's blobs by path: a file whose text is the same
   *  is not hashed again. */
  private lastBlobs = new Map<string, { text: string; id: string }>();
  /** Each commit's git note, by commit id. */
  private readonly notes = new Map<string, string>();
  private lastTime = 0;
  private skippedNow: string[] = [];

  /** `workPath`: a file of the caller's to hold the deflated objects (it
   *  is made, and removed by `finish` or `discard`). Null: ids only, to
   *  know a version's commit id (a bundle import's base); nothing is
   *  written and `finish` refuses. */
  constructor(private readonly workPath: string | null) {}

  /** The size of the pack so far (the deflated objects). */
  get packedBytes(): number {
    return this.packed;
  }

  /** The raw keys the last `add` left out (a name git may not hold, a
   *  second key of a path): a bundle import keeps them from the live tree. */
  get lastSkipped(): readonly string[] {
    return this.skippedNow;
  }

  /** The last commit's id, or null before the first. */
  get head(): string | null {
    return this.parent;
  }

  /** Store an object once; its id. */
  private async put(type: ObjType, body: Buffer): Promise<string> {
    const id = createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
    if (!this.ids.has(id) && this.workPath !== null) {
      this.ids.add(id);
      this.work ??= await open(this.workPath, 'w');
      const entry = Buffer.concat([entryHead(type, body.length), await deflate(body)]);
      await this.work.write(entry);
      this.packed += entry.length;
    }
    return id;
  }

  private async tree(dir: Dir): Promise<string> {
    const entries: { name: string; mode: string; id: string; sortKey: string }[] = [];
    for (const [name, id] of dir.files) entries.push({ name, mode: '100644', id, sortKey: name });
    for (const [name, sub] of dir.dirs) {
      // git orders a folder as if its name ended in '/'.
      entries.push({ name, mode: '40000', id: await this.tree(sub), sortKey: `${name}/` });
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
    const body = Buffer.concat(
      entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, 'hex')]),
    );
    return this.put('tree', body);
  }

  /** A file's blob id: the previous version's when the text is the same. */
  private async blob(path: string, text: string): Promise<string> {
    const last = this.lastBlobs.get(path);
    if (last && last.text === text) return last.id;
    return this.put('blob', Buffer.from(text, 'utf8'));
  }

  /**
   * Add a commit on the one before (oldest first). Paths are the tree's keys
   * made plain (normCodePath); a key that is already plain wins over another
   * that names the same path, and one git may not hold is left out and
   * listed. One at a time, so a caller holds one version's files at once
   * and can stop at a size (packedBytes).
   */
  async add(c: BundleCommit): Promise<void> {
    const n = ++this.count;
    this.skippedNow = [];
    // Each path's key: the plain one when the tree holds it, else the first
    // in sort order, so which text is kept does not depend on stored order.
    const keyOf = new Map<string, string>();
    for (const raw of Object.keys(c.files).sort()) {
      const path = normCodePath(raw);
      const had = keyOf.get(path);
      if (had === undefined) keyOf.set(path, raw);
      else if (raw === path) {
        keyOf.set(path, raw);
        this.skip({ commit: n, path: had, why: 'two keys name one path' });
      } else this.skip({ commit: n, path: raw, why: 'two keys name one path' });
    }
    const root = emptyDir();
    const blobs = new Map<string, { text: string; id: string }>();
    for (const path of [...keyOf.keys()].sort()) {
      const raw = keyOf.get(path)!;
      const parts = path.split('/');
      const why = badBundlePath(path);
      if (why) {
        this.skip({ commit: n, path: raw, why });
        continue;
      }
      let dir = root;
      let clash = false;
      for (const part of parts.slice(0, -1)) {
        if (dir.files.has(part)) {
          clash = true;
          break;
        }
        let sub = dir.dirs.get(part);
        if (!sub) dir.dirs.set(part, (sub = emptyDir()));
        dir = sub;
      }
      const name = parts[parts.length - 1]!;
      if (clash || dir.dirs.has(name)) {
        this.skip({ commit: n, path: raw, why: 'a file and a folder of one name' });
        continue;
      }
      const text = c.files[raw]!;
      const id = await this.blob(path, text);
      blobs.set(path, { text, id });
      dir.files.set(name, id);
    }
    this.lastBlobs = blobs;
    const tree = await this.tree(root);
    const time = Number.isFinite(c.time) ? Math.min(Math.max(0, Math.floor(c.time)), 2 ** 32) : 0;
    const who = `${oneLine(c.author)} <> ${time} +0000`;
    const message = c.message.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
    const body = [
      `tree ${tree}`,
      ...(this.parent ? [`parent ${this.parent}`] : []),
      `author ${who}`,
      `committer ${who}`,
      '',
      `${message || 'version'}\n`,
    ].join('\n');
    this.parent = await this.put('commit', Buffer.from(body, 'utf8'));
    this.lastTime = time;
    const note = (c.gitNote ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
    if (note) this.notes.set(this.parent, `${note}\n`);
  }

  /** The notes commit (one tree of blobs named by commit id, no parent),
   *  or null with no notes. Its time is the last version's. */
  private async notesCommit(): Promise<string | null> {
    if (this.notes.size === 0) return null;
    const ids = [...this.notes.keys()].sort();
    const entries: Buffer[] = [];
    for (const id of ids) {
      const blob = await this.put('blob', Buffer.from(this.notes.get(id)!, 'utf8'));
      entries.push(Buffer.from(`100644 ${id}\0`), Buffer.from(blob, 'hex'));
    }
    const tree = await this.put('tree', Buffer.concat(entries));
    const who = `notes <> ${this.lastTime} +0000`;
    const body = `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nversion notes\n`;
    return this.put('commit', Buffer.from(body, 'utf8'));
  }

  /** Write the bundle to `dest`: the refs (main and HEAD at the last
   *  commit), then the pack and its SHA-1, read back from the work file. */
  async finish(dest: string): Promise<BundleResult> {
    const head = this.parent;
    if (!head || !this.work || this.workPath === null) {
      throw new Error('a bundle needs at least one commit and a work file');
    }
    const notes = await this.notesCommit();
    await this.work.close();
    this.work = null;
    const out = await open(dest, 'w');
    try {
      await out.write(
        `# v2 git bundle\n${head} refs/heads/${BUNDLE_BRANCH}\n` +
          (notes ? `${notes} ${NOTES_REF}\n` : '') +
          `${head} HEAD\n\n`,
      );
      const sha = createHash('sha1');
      const packHead = Buffer.alloc(12);
      packHead.write('PACK', 0, 'ascii');
      packHead.writeUInt32BE(2, 4);
      packHead.writeUInt32BE(this.ids.size, 8);
      sha.update(packHead);
      await out.write(packHead);
      for await (const chunk of createReadStream(this.workPath)) {
        sha.update(chunk as Buffer);
        await out.write(chunk as Buffer);
      }
      await out.write(sha.digest());
      const { size } = await out.stat();
      return {
        bytes: size,
        head,
        commits: this.count,
        skipped: [...this.skipped],
        skippedCount: this.skippedCount,
      };
    } finally {
      await out.close();
      await rm(this.workPath, { force: true });
    }
  }

  /** List a path left out: the first SKIPPED_KEPT, and a count of all. */
  private skip(entry: BundleResult['skipped'][number]): void {
    this.skippedNow.push(entry.path);
    this.skippedCount++;
    if (this.skipped.length < SKIPPED_KEPT) this.skipped.push(entry);
  }

  /** Remove the work file (a bundle given up on). */
  async discard(): Promise<void> {
    await this.work?.close();
    this.work = null;
    if (this.workPath !== null) await rm(this.workPath, { force: true });
  }
}

/** A pack entry's head: the type and the inflated size (git's varint: 4
 *  bits of size in the first byte, 7 in each after). */
function entryHead(type: ObjType, length: number): Buffer {
  let size = length;
  const head: number[] = [(TYPE_CODE[type] << 4) | (size & 0x0f)];
  size >>>= 4;
  while (size > 0) {
    head[head.length - 1] = head[head.length - 1]! | 0x80;
    head.push(size & 0x7f);
    size >>>= 7;
  }
  return Buffer.from(head);
}

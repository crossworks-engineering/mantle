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
 * reads a database; the caller hands in the versions.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { badNewPath, normCodePath } from './target-ref';

/** One commit: a version's files and who made it, when. */
export type BundleCommit = {
  files: Readonly<Record<string, string>>;
  /** The author name: a role name or a login id, never an email. */
  author: string;
  /** Seconds since the epoch. */
  time: number;
  message: string;
};

export type BundleResult = {
  bytes: Buffer;
  /** The tip commit's id (refs/heads/main and HEAD). */
  head: string;
  commits: number;
  /** Paths left out of a commit: a name git may not hold (a `.git` part,
   *  `..`), or one a folder of the same name took. */
  skipped: { commit: number; path: string; why: string }[];
};

/** The branch the bundle carries. */
export const BUNDLE_BRANCH = 'main';

type ObjType = 'commit' | 'tree' | 'blob';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3 };

/** A folder of a commit's tree: files by name, folders by name. */
type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };

const emptyDir = (): Dir => ({ files: new Map(), dirs: new Map() });

/** Why git may not hold a path part, or null. `.git` in any case (and with
 *  the dots or spaces Windows drops) is refused by every git client. */
function badGitPart(part: string): string | null {
  if (part.replace(/[. ]+$/, '').toLowerCase() === '.git') return "a '.git' part";
  return null;
}

/** A one-line field of a commit (author): no control character, no `<>`. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim() || 'unknown';
}

export class GitBundleWriter {
  private readonly objects = new Map<string, Buffer>();
  private readonly order: string[] = [];

  /** Store an object once; its id. */
  private put(type: ObjType, body: Buffer): string {
    const id = createHash('sha1')
      .update(`${type} ${body.length}\0`)
      .update(body)
      .digest('hex');
    if (!this.objects.has(id)) {
      this.objects.set(id, packEntry(type, body));
      this.order.push(id);
    }
    return id;
  }

  /** The size of the pack so far (the deflated objects). */
  get packedBytes(): number {
    let n = 0;
    for (const b of this.objects.values()) n += b.length;
    return n;
  }

  private tree(dir: Dir): string {
    const entries: { name: string; mode: string; id: string; sortKey: string }[] = [];
    for (const [name, text] of dir.files) {
      entries.push({
        name,
        mode: '100644',
        id: this.put('blob', Buffer.from(text, 'utf8')),
        sortKey: name,
      });
    }
    for (const [name, sub] of dir.dirs) {
      // git orders a folder as if its name ended in '/'.
      entries.push({ name, mode: '40000', id: this.tree(sub), sortKey: `${name}/` });
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
    const body = Buffer.concat(
      entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, 'hex')]),
    );
    return this.put('tree', body);
  }

  private parent: string | null = null;
  private count = 0;
  private readonly skipped: BundleResult['skipped'] = [];

  /**
   * Add a commit on the one before (oldest first). Paths are the tree's keys
   * made plain (normCodePath); one git may not hold is left out and listed.
   * One at a time, so a caller holds one version's files at once and can
   * stop at a size (packedBytes).
   */
  add(c: BundleCommit): void {
    const n = ++this.count;
    const root = emptyDir();
    // Sorted, so which of two clashing paths is kept does not depend on
    // the key order the row was stored in.
    for (const raw of Object.keys(c.files).sort()) {
      const path = normCodePath(raw);
      const parts = path.split('/');
      const why = badNewPath(path) ?? parts.map(badGitPart).find((w) => w !== null) ?? null;
      if (why) {
        this.skipped.push({ commit: n, path: raw, why });
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
      if (clash || dir.dirs.has(name) || dir.files.has(name)) {
        this.skipped.push({ commit: n, path: raw, why: 'a file and a folder of one name' });
        continue;
      }
      dir.files.set(name, c.files[raw]!);
    }
    const tree = this.tree(root);
    const who = `${oneLine(c.author)} <> ${Math.max(0, Math.floor(c.time))} +0000`;
    const message = c.message.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    const body = [
      `tree ${tree}`,
      ...(this.parent ? [`parent ${this.parent}`] : []),
      `author ${who}`,
      `committer ${who}`,
      '',
      `${message || 'version'}\n`,
    ].join('\n');
    this.parent = this.put('commit', Buffer.from(body, 'utf8'));
  }

  /** The bundle: the refs (main and HEAD at the last commit) and the pack. */
  finish(): BundleResult {
    const head = this.parent;
    if (!head) throw new Error('a bundle needs at least one commit');
    const header = Buffer.from(
      `# v2 git bundle\n${head} refs/heads/${BUNDLE_BRANCH}\n${head} HEAD\n\n`,
      'utf8',
    );
    return {
      bytes: Buffer.concat([header, this.pack()]),
      head,
      commits: this.count,
      skipped: [...this.skipped],
    };
  }

  private pack(): Buffer {
    const head = Buffer.alloc(12);
    head.write('PACK', 0, 'ascii');
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(this.order.length, 8);
    const body = Buffer.concat([head, ...this.order.map((id) => this.objects.get(id)!)]);
    return Buffer.concat([body, createHash('sha1').update(body).digest()]);
  }
}

/** One pack entry: the type and the inflated size (git's varint: 4 bits
 *  of size in the first byte, 7 in each after), then the deflated body. */
function packEntry(type: ObjType, body: Buffer): Buffer {
  let size = body.length;
  const head: number[] = [(TYPE_CODE[type] << 4) | (size & 0x0f)];
  size >>>= 4;
  while (size > 0) {
    head[head.length - 1] = head[head.length - 1]! | 0x80;
    head.push(size & 0x7f);
    size >>>= 7;
  }
  return Buffer.concat([Buffer.from(head), deflateSync(body)]);
}

/**
 * Pictures on disk, not in memory (every picture of a PDF; Jason,
 * 2026-11-19: "no cap"): the picture pass that reads a PDF in page windows
 * (./pdf-picture-windows.ts) writes each window's pictures here as they
 * come, so the brain holds one window's pictures at most, never every
 * window's. A ReadonlyMap of name to bytes, as a run's `pictures` is
 * everywhere; a read is one file from disk.
 *
 * One folder a spool, under the system temp folder, `mantle-pictures-*`.
 * The picture pass drops it once it has saved the pictures, in the same
 * job. A spool nothing takes goes when it is collected, and a
 * folder of an earlier process that died is removed by the next spool after
 * SPOOL_STALE_MS. Only folders of this prefix are ever removed.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREFIX = 'mantle-pictures-';
/** A spool folder older than this is one no process takes any more. */
export const SPOOL_STALE_MS = 24 * 60 * 60 * 1000;

const collected = new FinalizationRegistry<string>((dir) => {
  rmSync(dir, { recursive: true, force: true });
});

/** Remove the spool folders of an earlier process: older than SPOOL_STALE_MS. */
function sweepStale(now: number): void {
  // A folder last written before this is one no process takes any more.
  const staleBefore = now - SPOOL_STALE_MS;
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < staleBefore) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Gone already, or not ours to read: left as it is.
    }
  }
}

export class SpooledPictures implements ReadonlyMap<string, Buffer> {
  private folder: string | null = null;
  private readonly files = new Map<string, string>();
  private bytesOnDisk = 0;

  /** The folder, made on the first picture. */
  private dir(): string {
    if (this.folder) return this.folder;
    sweepStale(Date.now());
    this.folder = mkdtempSync(path.join(tmpdir(), PREFIX));
    collected.register(this, this.folder, this);
    return this.folder;
  }

  /** Write one picture to disk under `name` (a second of a name replaces it). */
  put(name: string, bytes: Buffer): void {
    const at = path.join(this.dir(), `${this.files.size + 1}.bin`);
    writeFileSync(at, bytes);
    this.files.set(name, at);
    this.bytesOnDisk += bytes.length;
  }

  /** The bytes the spool holds on disk. */
  get diskBytes(): number {
    return this.bytesOnDisk;
  }

  /** Remove the folder and every picture: the caller is done. */
  drop(): void {
    if (this.folder) {
      collected.unregister(this);
      rmSync(this.folder, { recursive: true, force: true });
      this.folder = null;
    }
    this.files.clear();
  }

  get size(): number {
    return this.files.size;
  }
  has(name: string): boolean {
    return this.files.has(name);
  }
  get(name: string): Buffer | undefined {
    const at = this.files.get(name);
    if (!at) return undefined;
    try {
      return readFileSync(at);
    } catch {
      return undefined;
    }
  }
  keys(): MapIterator<string> {
    return this.files.keys();
  }
  *values(): MapIterator<Buffer> {
    for (const name of this.files.keys()) {
      const b = this.get(name);
      if (b) yield b;
    }
  }
  *entries(): MapIterator<[string, Buffer]> {
    for (const name of this.files.keys()) {
      const b = this.get(name);
      if (b) yield [name, b];
    }
  }
  [Symbol.iterator](): MapIterator<[string, Buffer]> {
    return this.entries();
  }
  forEach(fn: (value: Buffer, key: string, map: ReadonlyMap<string, Buffer>) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this);
  }
}

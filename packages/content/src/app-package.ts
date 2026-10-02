/**
 * App packages and copies (apps first-class plan, Phase 3;
 * docs/app-authoring-guide.md, "Export, import and duplicate").
 *
 * A `.mantleapp` file is a zip with two entries:
 *
 *   mantleapp.json  the app: name and look, the published code and the draft,
 *                   the declared tools and schema (AppPackage below)
 *   data.sqlite     a copy of its database (optional)
 *
 * Builds do not travel: a bundle lives in the exporting brain's object store,
 * so an import builds the code again (packages/tools app-package-import.ts).
 * A duplicate stays in the same brain and keeps the builds.
 *
 * Neither carries what belongs to the original: its sharing and level, its
 * history, and its table exports (an app's table export has one master,
 * app-table-exports.ts). An import or a copy starts admin-only in Unsorted.
 *
 * Server-only (node:fs, the SQL child): import via
 * '@mantle/content/app-package'.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { db, nodes, type AppManifest, type AppSource } from '@mantle/db';
import type { AppDetail, AppTint } from '@mantle/client-types';
import {
  AppSourceLimitError,
  MAX_APP_FILE_BYTES,
  MAX_APP_FILES,
  assertSourceWithinLimits,
  createApp,
  getApp,
  installAppCode,
  setManifest,
  type AppHistoryActor,
} from './apps';
import {
  appDatabasePath,
  appDbRoot,
  removeAppDatabaseFiles,
  restoreAppDatabaseFile,
  snapshotAppDatabase,
} from './app-broker';
import { adoptAppDbFile, appSqlMaxDbBytes } from './app-sql-runner';
import { notifyAppNavChanged } from './app-nav';

export const APP_PACKAGE_FORMAT = 'mantleapp';
export const APP_PACKAGE_VERSION = 1;
export const APP_PACKAGE_EXT = '.mantleapp';
const MANIFEST_ENTRY = 'mantleapp.json';
const DATA_ENTRY = 'data.sqlite';

/** The largest mantleapp.json: two full source trees (published and draft)
 *  and the schema, with room for JSON escaping. */
const MAX_MANIFEST_BYTES = 2 * MAX_APP_FILES * MAX_APP_FILE_BYTES * 2 + 1024 * 1024;

/** What mantleapp.json holds. */
export type AppPackage = {
  format: typeof APP_PACKAGE_FORMAT;
  version: typeof APP_PACKAGE_VERSION;
  exportedAt: string;
  app: {
    title: string;
    description?: string;
    icon?: string;
    color?: string;
    tags: string[];
  };
  code: {
    /** The published code (what runs). */
    source: AppSource;
    /** Unpublished work, or null. */
    draft: AppSource | null;
    /** The source had a green build: an import builds and publishes it. */
    published: boolean;
  };
  manifest: Pick<AppManifest, 'toolSlugs' | 'sqlite'>;
  /** The database copy in data.sqlite, or null when the package has none. */
  data: { file: typeof DATA_ENTRY; bytes: number; schemaVersion: number } | null;
};

/** The file is not a usable app package; the message says why. */
export class AppPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppPackageError';
  }
}

/** The largest package an import reads: a full database and the code. */
export function appPackageMaxBytes(): number {
  return appSqlMaxDbBytes() + MAX_MANIFEST_BYTES;
}

/** Imports at a time per process: each holds its package in memory while
 *  it is read (apps audit 2026-10-02, item 13). */
export const APP_IMPORT_MAX_PARALLEL = 2;
let importsRunning = 0;

/** A turn to import a package, or null when APP_IMPORT_MAX_PARALLEL are
 *  running. Take it BEFORE the package is read; call the release when done
 *  (once). The route and the app_import tool share it. */
export function takeAppImportSlot(): (() => void) | null {
  if (importsRunning >= APP_IMPORT_MAX_PARALLEL) return null;
  importsRunning++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    importsRunning--;
  };
}

/** The most entries a package may have. Ours has two; a zip's entry list is
 *  read whole into memory before any entry, so a crafted one with millions
 *  of entries must be refused before it is parsed. */
const MAX_PACKAGE_ENTRIES = 16;

/** The entry count a zip's end record claims, or null when it has none
 *  (not a zip). Read from the last bytes only, before the zip is parsed. */
function zipEntryCount(bytes: Buffer | Uint8Array): number | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  // The end record is 22 bytes plus a comment of at most 65535.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  }
  return null;
}

// ── temp files ──────────────────────────────────────────────────────────────

/** Work files live under APP_DB_DIR/_tmp: the same volume as the app files
 *  (a restore copies from there), outside the backup's reach. */
function tmpDir(): string {
  return path.join(appDbRoot(), '_tmp');
}

const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Remove work files an interrupted export or import left behind. */
async function sweepTmp(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(tmpDir());
  } catch {
    return;
  }
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(tmpDir(), name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
    } catch {
      // gone already
    }
  }
}

/** A fresh path for a work file (the caller removes it). */
export async function appPackageTempPath(ext: string): Promise<string> {
  await mkdir(tmpDir(), { recursive: true });
  void sweepTmp();
  return path.join(tmpDir(), `${randomUUID()}${ext}`);
}

// ── export ──────────────────────────────────────────────────────────────────

/** A file name for an app's package. */
export function appPackageFileName(title: string): string {
  return `${title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'app'}${APP_PACKAGE_EXT}`;
}

/**
 * Write an app's package to `dest`: its code and, unless `withData` is
 * false, a consistent copy of its database. Null when the app is not this
 * owner's. Throws AppDbMissingError when the app's database file is lost
 * (export without the data then).
 */
export async function writeAppPackage(
  ownerId: string,
  appId: string,
  dest: string,
  opts: { withData?: boolean } = {},
): Promise<{ title: string; bytes: number; hasData: boolean } | null> {
  const app = await getApp(ownerId, appId);
  if (!app) return null;
  const dataTmp = opts.withData === false ? null : await appPackageTempPath('.sqlite');
  try {
    const data = dataTmp ? await snapshotAppDatabase(ownerId, appId, dataTmp) : null;
    const pkg: AppPackage = {
      format: APP_PACKAGE_FORMAT,
      version: APP_PACKAGE_VERSION,
      exportedAt: new Date().toISOString(),
      app: {
        title: app.title,
        ...(app.manifest.description ? { description: app.manifest.description } : {}),
        ...(app.icon ? { icon: app.icon } : {}),
        ...(app.color ? { color: app.color } : {}),
        tags: app.tags,
      },
      code: {
        source: app.source,
        draft: app.draft,
        published: app.publishedBuild?.ok === true,
      },
      manifest: {
        ...(app.manifest.toolSlugs ? { toolSlugs: app.manifest.toolSlugs } : {}),
        ...(app.manifest.sqlite ? { sqlite: app.manifest.sqlite } : {}),
      },
      data: data
        ? { file: DATA_ENTRY, bytes: data.bytes, schemaVersion: data.schemaVersion }
        : null,
    };
    const zip = new JSZip();
    zip.file(MANIFEST_ENTRY, JSON.stringify(pkg, null, 2));
    // Stored, not deflated: jszip compresses in JavaScript on this thread, and
    // deflating a 256 MB database held the process for seconds (apps audit
    // 2026-10-02, low).
    if (data && dataTmp) {
      zip.file(DATA_ENTRY, createReadStream(dataTmp), { compression: 'STORE' });
    }
    await pipeline(
      zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      }),
      createWriteStream(dest),
    );
    const { size } = await stat(dest);
    return { title: app.title, bytes: size, hasData: data !== null };
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  } finally {
    if (dataTmp) await rm(dataTmp, { force: true });
  }
}

// ── read ────────────────────────────────────────────────────────────────────

/** An entry's bytes as a modern stream (jszip hands out an old-style one,
 *  which is neither async-iterable nor safe in `pipeline`). */
function entryStream(entry: JSZip.JSZipObject): Readable {
  return new Readable().wrap(entry.nodeStream('nodebuffer'));
}

/** One zip entry's bytes, refusing past `max` (a zip can claim any size). */
async function readEntryCapped(entry: JSZip.JSZipObject, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of entryStream(entry) as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > max) {
      throw new AppPackageError(`${entry.name} is larger than ${Math.round(max / 1048576)} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One zip entry written to `dest`, refusing past `max`. */
async function writeEntryCapped(
  entry: JSZip.JSZipObject,
  dest: string,
  max: number,
): Promise<void> {
  const out = createWriteStream(dest);
  let total = 0;
  try {
    await pipeline(
      entryStream(entry),
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Buffer>) {
          total += chunk.length;
          if (total > max) {
            throw new AppPackageError(
              `the app's data is larger than ${Math.round(max / 1048576)} MB (APP_SQL_MAX_DB_MB)`,
            );
          }
          yield chunk;
        }
      },
      out,
    );
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readSource(v: unknown, what: string): AppSource {
  if (!isObj(v) || typeof v.entry !== 'string' || !isObj(v.files)) {
    throw new AppPackageError(`${what} is not a source tree ({ entry, files })`);
  }
  const files: Record<string, string> = {};
  for (const [p, body] of Object.entries(v.files)) {
    if (typeof body !== 'string') throw new AppPackageError(`${what}: file '${p}' is not text`);
    files[p] = body;
  }
  if (!Object.hasOwn(files, v.entry)) {
    throw new AppPackageError(`${what}: the entry '${v.entry}' is not one of its files`);
  }
  const source = { entry: v.entry, files };
  try {
    assertSourceWithinLimits(source);
  } catch (err) {
    if (err instanceof AppSourceLimitError) throw new AppPackageError(`${what}: ${err.message}`);
    throw err;
  }
  return source;
}

function readPackageJson(v: unknown): AppPackage {
  if (!isObj(v) || v.format !== APP_PACKAGE_FORMAT) {
    throw new AppPackageError(`${MANIFEST_ENTRY} is not a Mantle app package`);
  }
  if (v.version !== APP_PACKAGE_VERSION) {
    throw new AppPackageError(
      `this package is format version ${String(v.version)}; this brain reads version ${APP_PACKAGE_VERSION}`,
    );
  }
  const app = isObj(v.app) ? v.app : {};
  const code = isObj(v.code) ? v.code : {};
  const manifest = isObj(v.manifest) ? v.manifest : {};
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const title = str(app.title)?.trim();
  if (!title) throw new AppPackageError('the package has no app name');
  const toolSlugs = manifest.toolSlugs;
  if (
    toolSlugs !== undefined &&
    (!Array.isArray(toolSlugs) || toolSlugs.some((s) => typeof s !== 'string'))
  ) {
    throw new AppPackageError('manifest.toolSlugs is not a list of tool slugs');
  }
  const sqlite = manifest.sqlite;
  if (
    sqlite !== undefined &&
    (!isObj(sqlite) ||
      typeof sqlite.schemaSql !== 'string' ||
      !Number.isInteger(sqlite.schemaVersion) ||
      (sqlite.schemaVersion as number) < 0)
  ) {
    throw new AppPackageError('manifest.sqlite is not { schemaSql, schemaVersion }');
  }
  let data: AppPackage['data'] = null;
  if (v.data !== null && v.data !== undefined) {
    const d = isObj(v.data) ? v.data : {};
    if (!Number.isInteger(d.schemaVersion) || (d.schemaVersion as number) < 0) {
      throw new AppPackageError('data.schemaVersion is not a whole number');
    }
    data = {
      file: DATA_ENTRY,
      bytes: typeof d.bytes === 'number' ? d.bytes : 0,
      schemaVersion: d.schemaVersion as number,
    };
  }
  const tags = Array.isArray(app.tags) ? app.tags.filter((t) => typeof t === 'string') : [];
  return {
    format: APP_PACKAGE_FORMAT,
    version: APP_PACKAGE_VERSION,
    exportedAt: str(v.exportedAt) ?? '',
    app: {
      title: title.slice(0, 200),
      ...(str(app.description) ? { description: str(app.description)!.slice(0, 2000) } : {}),
      ...(str(app.icon) ? { icon: str(app.icon) } : {}),
      ...(str(app.color) ? { color: str(app.color) } : {}),
      tags: tags.slice(0, 20),
    },
    code: {
      source: readSource(code.source, 'code.source'),
      draft:
        code.draft === null || code.draft === undefined
          ? null
          : readSource(code.draft, 'code.draft'),
      published: code.published === true,
    },
    manifest: {
      ...(toolSlugs ? { toolSlugs: (toolSlugs as string[]).slice(0, 100) } : {}),
      ...(sqlite ? { sqlite: sqlite as { schemaSql: string; schemaVersion: number } } : {}),
    },
    data,
  };
}

/** A package, read and checked; `data` reads its database out on demand. */
export type OpenedAppPackage = {
  pkg: AppPackage;
  /** Check the package's database and copy it clean to a work file (the
   *  caller removes it). Null when the package has no data. Throws
   *  AppPackageError when it is damaged or too large. */
  extractData(): Promise<{ path: string; schemaVersion: number } | null>;
};

/** Read a `.mantleapp` file. Throws AppPackageError when it is not one. */
export async function openAppPackage(bytes: Buffer | Uint8Array): Promise<OpenedAppPackage> {
  const entries = zipEntryCount(bytes);
  if (entries === null) {
    throw new AppPackageError(`this is not a ${APP_PACKAGE_EXT} file (it is not a zip)`);
  }
  if (entries > MAX_PACKAGE_ENTRIES) {
    throw new AppPackageError(
      `this zip has ${entries} entries; a ${APP_PACKAGE_EXT} file has ${MAX_PACKAGE_ENTRIES} at most`,
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new AppPackageError(`this is not a ${APP_PACKAGE_EXT} file (it is not a zip)`);
  }
  const entry = zip.file(MANIFEST_ENTRY);
  if (!entry) throw new AppPackageError(`this zip has no ${MANIFEST_ENTRY}`);
  let json: unknown;
  try {
    json = JSON.parse((await readEntryCapped(entry, MAX_MANIFEST_BYTES)).toString('utf8'));
  } catch (err) {
    if (err instanceof AppPackageError) throw err;
    throw new AppPackageError(`${MANIFEST_ENTRY} is not valid JSON`);
  }
  const pkg = readPackageJson(json);
  const dataEntry = pkg.data ? zip.file(DATA_ENTRY) : null;
  if (pkg.data && !dataEntry)
    throw new AppPackageError(`the package names ${DATA_ENTRY} but has none`);
  return {
    pkg,
    async extractData() {
      if (!pkg.data || !dataEntry) return null;
      const raw = await appPackageTempPath('.upload.sqlite');
      const clean = await appPackageTempPath('.sqlite');
      try {
        await writeEntryCapped(dataEntry, raw, appSqlMaxDbBytes());
        try {
          await adoptAppDbFile(raw, clean);
        } catch (err) {
          throw new AppPackageError(
            `${DATA_ENTRY} is not a sound SQLite database: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if ((await stat(clean)).size > appSqlMaxDbBytes()) {
          throw new AppPackageError(
            `the app's data is larger than ${Math.round(appSqlMaxDbBytes() / 1048576)} MB (APP_SQL_MAX_DB_MB)`,
          );
        }
        return { path: clean, schemaVersion: pkg.data.schemaVersion };
      } catch (err) {
        await rm(clean, { force: true });
        throw err;
      } finally {
        await rm(raw, { force: true });
      }
    },
  };
}

// ── install ─────────────────────────────────────────────────────────────────

/** Remove a just-made app that could not be finished (no snapshot: it never
 *  held anything of the owner's): an import, a copy or an undelete that
 *  failed half way leaves nothing behind. */
export async function dropUnfinishedApp(ownerId: string, appId: string): Promise<void> {
  const dbPath = await appDatabasePath(ownerId, appId);
  await db.delete(nodes).where(eq(nodes.id, appId));
  if (dbPath) await removeAppDatabaseFiles(dbPath).catch(() => {});
}

/**
 * Make a new app from a package: its name and look, its PUBLISHED source
 * (unbuilt: the caller builds and publishes, then stages the draft), the
 * declared tools given in `toolSlugs` (the caller keeps the ones this brain
 * has) and schema, and the checked database from `extractData`. Nothing is
 * left behind when a step fails.
 */
export async function installAppPackage(
  ownerId: string,
  pkg: AppPackage,
  opts: {
    title?: string;
    toolSlugs: string[];
    data: { path: string; schemaVersion: number } | null;
  },
): Promise<AppDetail> {
  const app = await createApp(ownerId, {
    title: opts.title?.trim() || pkg.app.title,
    ...(pkg.app.icon ? { icon: pkg.app.icon } : {}),
    ...(pkg.app.color ? { color: pkg.app.color as AppTint } : {}),
    ...(pkg.app.description ? { description: pkg.app.description } : {}),
    tags: pkg.app.tags,
    source: pkg.code.source,
  });
  try {
    await setManifest(ownerId, app.id, {
      toolSlugs: opts.toolSlugs,
      ...(pkg.manifest.sqlite ? { sqlite: pkg.manifest.sqlite } : {}),
    });
    if (opts.data) {
      await restoreAppDatabaseFile(ownerId, app.id, opts.data.path, opts.data.schemaVersion, {
        drainMs: 0,
      });
    }
  } catch (err) {
    await dropUnfinishedApp(ownerId, app.id);
    throw err;
  }
  return app;
}

// ── duplicate ───────────────────────────────────────────────────────────────

/**
 * Copy an app in this brain: its name and look (the name gets " (copy)"),
 * its code with the builds (so a published app is live at once), its draft,
 * its declared tools and schema, and, unless `withData` is false, its data.
 * Null when the app is not this owner's. Throws AppDbMissingError when the
 * database file is lost (copy without the data then).
 */
export async function duplicateApp(
  ownerId: string,
  appId: string,
  opts: { title?: string; withData?: boolean; actor?: AppHistoryActor } = {},
): Promise<{ id: string; title: string; hasData: boolean } | null> {
  const app = await getApp(ownerId, appId);
  if (!app) return null;
  // The data first: when it cannot be copied, nothing has been made yet.
  const dataTmp = opts.withData === false ? null : await appPackageTempPath('.sqlite');
  try {
    const data = dataTmp ? await snapshotAppDatabase(ownerId, appId, dataTmp) : null;
    const copy = await createApp(ownerId, {
      title: opts.title?.trim() || `${app.title} (copy)`,
      ...(app.icon ? { icon: app.icon } : {}),
      ...(app.color ? { color: app.color } : {}),
      ...(app.manifest.description ? { description: app.manifest.description } : {}),
      tags: app.tags,
      source: app.source,
    });
    try {
      await installAppCode(
        ownerId,
        copy.id,
        {
          source: app.source,
          draft: app.draft,
          manifest: app.manifest,
          publishedBuild: app.publishedBuild,
          draftBuild: app.draftBuild,
        },
        { note: `copied from ${app.title}`.slice(0, 500), actor: opts.actor ?? 'owner' },
      );
      if (data && dataTmp) {
        await restoreAppDatabaseFile(ownerId, copy.id, dataTmp, data.schemaVersion, {
          drainMs: 0,
        });
      }
    } catch (err) {
      await dropUnfinishedApp(ownerId, copy.id);
      throw err;
    }
    void notifyAppNavChanged(ownerId);
    return { id: copy.id, title: copy.title, hasData: data !== null };
  } finally {
    if (dataTmp) await rm(dataTmp, { force: true });
  }
}

/**
 * The one check of an own package (docs/pipelines.md, "Own pipelines"), at
 * install and at a draft test. Pure: it reads the value it is given.
 *
 * A package is `{ files: path -> text | { base64 } }`, at most
 * PIPELINE_PACKAGE_FILES_MAX files and PIPELINE_PACKAGE_MAX_BYTES of bytes
 * on disk. A text file holds no NUL character (Postgres keeps none in a
 * jsonb text; such a file is sent as base64). Each path passes the one path rule of a tree of files
 * (badNewPath, @mantle/std). `pipeline.json` is text, its JSON passes
 * checkManifest with the rules of an own pipeline, and its entry is a file
 * of the package.
 *
 * The answer gives the files as bytes (what the folder writer writes) and
 * the package's hash: the sha256 of the JSON of `files` with the paths in
 * order, so the same files give the same hash whatever order they came in.
 * Nothing of the code is read or judged (owner, 2026-11-15: the Admin's
 * package; no scan).
 */
import { createHash } from 'node:crypto';
import { badNewPath } from '@mantle/std';
import {
  PIPELINE_MANIFEST_FILE,
  PIPELINE_PACKAGE_FILES_MAX,
  PIPELINE_PACKAGE_MAX_BYTES,
  type PipelineManifest,
  type PipelinePackage,
  type PipelinePackageFile,
} from './contract';
import { checkManifest } from './manifest-check';

export type PackageCheck =
  | {
      ok: true;
      manifest: PipelineManifest;
      /** The package as it is stored: the files in path order. */
      pkg: PipelinePackage;
      /** Path -> bytes, in path order. */
      bytes: ReadonlyMap<string, Buffer>;
      /** The sha256 of the JSON of the files, paths in order. */
      hash: string;
    }
  | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One file as bytes, or the sentence of what is wrong with it. */
function bytesOf(path: string, file: unknown): Buffer | string {
  if (typeof file === 'string') {
    // Postgres keeps no NUL character in a jsonb text: such a file is a
    // binary one.
    if (file.includes('\u0000')) {
      return `The file ${JSON.stringify(path.slice(0, 80))} holds a NUL character: send it as { "base64": "..." }.`;
    }
    return Buffer.from(file, 'utf8');
  }
  if (isObject(file) && typeof file.base64 === 'string' && Object.keys(file).length === 1) {
    const b64 = file.base64.replace(/\s/g, '');
    if (b64.length % 4 === 0 && BASE64.test(b64)) return Buffer.from(b64, 'base64');
  }
  return `The file ${JSON.stringify(path.slice(0, 80))} must be text, or { "base64": "..." } for a binary file.`;
}

/** Check a package as an install or a draft test sends it. */
export function checkPackage(raw: unknown): PackageCheck {
  const files = isObject(raw) ? raw.files : undefined;
  if (!isObject(files)) {
    return { ok: false, error: 'Send the package as { "files": { "<path>": "<text>" } }.' };
  }
  const paths = Object.keys(files).sort();
  if (paths.length > PIPELINE_PACKAGE_FILES_MAX) {
    return {
      ok: false,
      error: `A package has at most ${PIPELINE_PACKAGE_FILES_MAX} files; this one has ${paths.length}.`,
    };
  }
  const bytes = new Map<string, Buffer>();
  const stored: Record<string, PipelinePackageFile> = {};
  let total = 0;
  for (const path of paths) {
    const bad = badNewPath(path, 'the package');
    if (bad) return { ok: false, error: `A file of the package: ${bad}.` };
    const b = bytesOf(path, files[path]);
    if (typeof b === 'string') return { ok: false, error: b };
    total += b.length;
    if (total > PIPELINE_PACKAGE_MAX_BYTES) {
      return {
        ok: false,
        error: `A package is at most ${PIPELINE_PACKAGE_MAX_BYTES / 1024 / 1024} MB of files.`,
      };
    }
    bytes.set(path, b);
    stored[path] = files[path] as PipelinePackageFile;
  }
  const text = files[PIPELINE_MANIFEST_FILE];
  if (typeof text !== 'string') {
    return {
      ok: false,
      error: `A package has its manifest as the text file ${PIPELINE_MANIFEST_FILE}.`,
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, error: `${PIPELINE_MANIFEST_FILE} is not JSON.` };
  }
  const checked = checkManifest(manifest, 'own');
  if (!checked.ok) return { ok: false, error: `${PIPELINE_MANIFEST_FILE}: ${checked.error}` };
  const entry = checked.manifest.entry ?? '';
  if (!bytes.has(entry)) {
    return { ok: false, error: `The entry ${JSON.stringify(entry)} is not a file of the package.` };
  }
  const pkg: PipelinePackage = { files: stored };
  return { ok: true, manifest: checked.manifest, pkg, bytes, hash: packageHash(pkg) };
}

/** The sha256 of the JSON of a package's files, paths in order: two sends
 *  of the same files have the same hash. */
export function packageHash(pkg: PipelinePackage): string {
  const sorted = Object.fromEntries(
    Object.keys(pkg.files)
      .sort()
      .map((p) => [p, pkg.files[p]]),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Where an own package lives on disk (docs/pipelines.md, "Own pipelines"):
 * the ONE builder of its path, for the web, which writes it
 * (packages/content/src/pipeline-folder.ts), and the parser, which reads
 * it from its read-only mount (server/parser/src/pipeline-index.ts).
 *
 *  - The root: MANTLE_PIPELINES_DIR (`/data/pipelines` in web and
 *    `/pipelines` in the parser on a box: one host folder,
 *    `${MANTLE_DATA_DIR}/pipelines`). Unset (dev, on the host): the
 *    monorepo root's `data/pipelines`, found from this file, so a
 *    worktree's web and parser agree.
 *  - A version in use: `<root>/<id>/<version>/`. A draft of a test:
 *    `<root>/.drafts/<id>/`. A write in progress: `<root>/.tmp-*`.
 *
 * A path is built only from two checked words: the id (PIPELINE_ID) and the
 * version (`x.y.z`). Nothing else of a request goes into a path; a word
 * that fails its pattern gives null.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@mantle/config';
import { PIPELINE_ID } from './manifest-check';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The folder of the drafts of tests. Its name starts with a dot: no id
 *  can (PIPELINE_ID). */
export const PIPELINE_DRAFTS = '.drafts';

let repoDefault: string | undefined;

/** The root of the own packages of this box. */
export function pipelinesDir(): string {
  const configured = env('MANTLE_PIPELINES_DIR');
  if (configured) return configured;
  if (repoDefault) return repoDefault;
  let root = process.cwd();
  for (let cur = path.dirname(fileURLToPath(import.meta.url)); ;) {
    if (existsSync(path.join(cur, 'pnpm-workspace.yaml'))) {
      root = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return (repoDefault = path.join(root, 'data', 'pipelines'));
}

/** The folder of one own package: its version in use, or its draft. Null
 *  when the id or the version is not of its form. */
export function ownPackageDir(
  id: unknown,
  version: unknown,
  draft = false,
  root = pipelinesDir(),
): string | null {
  if (typeof id !== 'string' || !PIPELINE_ID.test(id)) return null;
  if (draft) return path.join(root, PIPELINE_DRAFTS, id);
  if (typeof version !== 'string' || !SEMVER.test(version)) return null;
  return path.join(root, id, version);
}

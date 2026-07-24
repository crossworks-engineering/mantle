import 'server-only';

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { docsRoot } from '@mantle/files';

/**
 * Disk-backed read layer for the `/changelog` page. Entries are markdown files
 * named `<semver>.md` under `docs/_changelog/` — the `_` prefix keeps the
 * folder out of the `/docs` reader and brain indexing (see `isHiddenSegment`
 * in @mantle/files), while still shipping inside the image via
 * MANTLE_DOCS_ROOT like every other doc.
 */

const CHANGELOG_DIR = '_changelog';

/** Strict `x.y.z` — doubles as the path-traversal guard for reads. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function changelogRoot(): string {
  return path.join(docsRoot(), CHANGELOG_DIR);
}

/** Numeric semver compare, descending (newest first). */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pb[i]! - pa[i]!;
  }
  return 0;
}

/** All changelog versions on disk, newest first. `[]` when the dir is missing. */
export async function listChangelogVersions(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(changelogRoot());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.md') && VERSION_RE.test(name.slice(0, -3)))
    .map((name) => name.slice(0, -3))
    .sort(compareVersionsDesc);
}

export async function getLatestChangelogVersion(): Promise<string | null> {
  const versions = await listChangelogVersions();
  return versions[0] ?? null;
}

/** Markdown for one version, or null when missing/invalid (route 404s on null). */
export async function getChangelogMarkdown(version: string): Promise<string | null> {
  if (!VERSION_RE.test(version)) return null;
  try {
    return await fs.readFile(path.join(changelogRoot(), `${version}.md`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { docsRoot } from '@mantle/files';
import { changelogParts, compareVersionsDesc } from '@mantle/files/changelog-parts';

/**
 * Read layer for the `/changelog` page. Two sources, one list:
 *
 * - `CHANGELOG.md`, beside the docs root (`/app/CHANGELOG.md` next to
 *   `/app/docs` in the image): the live release notes, split on its release
 *   headings by the same reader the docs site uses.
 * - `docs/_changelog/<semver>.md`: the per-release files written up to
 *   0.232.35. They fill in the versions CHANGELOG.md does not hold. The `_`
 *   keeps the folder out of the `/docs` reader (`isHiddenSegment` in
 *   @mantle/files).
 *
 * A version in both reads from CHANGELOG.md.
 */

const CHANGELOG_DIR = '_changelog';
const CHANGELOG_FILE = 'CHANGELOG.md';

/** Strict `x.y.z`: doubles as the path-traversal guard for reads. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function changelogDir(): string {
  return path.join(docsRoot(), CHANGELOG_DIR);
}

function changelogFile(): string {
  return path.join(path.dirname(docsRoot()), CHANGELOG_FILE);
}

/** A file's text, or null when it is not there. */
async function readIfThere(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Every heading in a part one level up, outside code fences, so a release
 * reads as `# v0.500.3: title` with its entries as `##`, the shape the
 * `_changelog` files have.
 */
function liftHeadings(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      return !inFence && /^#{2,6} /.test(line) ? line.slice(1) : line;
    })
    .join('\n');
}

/** CHANGELOG.md's releases by version; a version written twice is joined in file order. */
async function fileReleases(): Promise<Map<string, string>> {
  const raw = await readIfThere(changelogFile());
  const releases = new Map<string, string>();
  if (raw === null) return releases;
  for (const { version, markdown } of changelogParts(raw)) {
    const lifted = liftHeadings(markdown);
    const before = releases.get(version);
    releases.set(version, before === undefined ? lifted : `${before}\n\n${lifted}`);
  }
  return releases;
}

/** The versions with a `_changelog` file. `[]` when the folder is missing. */
async function dirVersions(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(changelogDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.md') && VERSION_RE.test(name.slice(0, -3)))
    .map((name) => name.slice(0, -3));
}

/** Every changelog version, newest first. `[]` when neither source is there. */
export async function listChangelogVersions(): Promise<string[]> {
  const [releases, older] = await Promise.all([fileReleases(), dirVersions()]);
  return [...new Set([...releases.keys(), ...older])].sort(compareVersionsDesc);
}

export async function getLatestChangelogVersion(): Promise<string | null> {
  const versions = await listChangelogVersions();
  return versions[0] ?? null;
}

/** Markdown for one version, or null when missing or invalid (the route 404s on null). */
export async function getChangelogMarkdown(version: string): Promise<string | null> {
  if (!VERSION_RE.test(version)) return null;
  const fromFile = (await fileReleases()).get(version);
  if (fromFile !== undefined) return fromFile;
  return readIfThere(path.join(changelogDir(), `${version}.md`));
}

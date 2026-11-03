/**
 * CHANGELOG.md split into its release parts: the one reader of the release
 * notes, for the in-app Changelog (server/web/lib/changelog.ts) and the docs
 * site (docs-site/src/lib/guide.mjs).
 *
 * No imports and erasable types only, on purpose: the docs site loads this
 * file as it is, outside the workspace (Vite at build, Node's type stripping
 * for its page check).
 */

/** One release heading and everything up to the next one. */
export type ChangelogPart = {
  /** `x.y.z`, without the `v`. */
  version: string;
  /** The part as written, its own heading first. */
  markdown: string;
};

/**
 * A release heading in either form the file uses: `## v0.500.3: title`,
 * `## v0.400.70` (several entries below it as `###`), or the older
 * `## 0.239.13: title`.
 */
const RELEASE_HEADING_RE = /^## v?(\d+\.\d+\.\d+)(?=[\s:(]|$)/;

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The release parts in file order. The text above the first release heading
 * (the file's own title and intro) is left out. A heading inside a fenced code
 * block is text, never a new part. A version written twice gives two parts.
 */
export function changelogParts(raw: string): ChangelogPart[] {
  const parts: ChangelogPart[] = [];
  let version: string | null = null;
  let lines: string[] = [];
  let inFence = false;
  const close = () => {
    if (version) parts.push({ version, markdown: lines.join('\n').trimEnd() });
  };
  for (const line of raw.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : RELEASE_HEADING_RE.exec(line);
    if (m) {
      close();
      version = m[1]!;
      lines = [line];
    } else if (version) {
      lines.push(line);
    }
  }
  close();
  return parts;
}

/** Numeric semver compare, newest first. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pb[i]! - pa[i]!;
  }
  return 0;
}

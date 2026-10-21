#!/usr/bin/env node
// Regenerate the README's "By the numbers" block from the repo itself.
//
//   pnpm readme:stats            # rewrite the block in README.md
//   pnpm readme:stats --check    # exit 1 if the block is stale (CI-friendly)
//   pnpm readme:stats --print    # print the block, touch nothing
//
// Why a generator: hand-written stats in a README are wrong within a week, and
// a wrong number is worse than no number. Everything below is COUNTED from the
// working tree + git history at run time, so the block is either current or
// provably stale. The live CI/registry badges at the top of the README are
// shields.io endpoints and need no regeneration — only the counted ones live
// here.
//
// Runs on plain node (no deps, no network, no DB) so it is safe from any
// worktree and from CI. It is invoked automatically by scripts/bump-version.mjs,
// which means every `release:` commit on main carries fresh numbers.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const START = '<!-- stats:start -->';
const END = '<!-- stats:end -->';

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const read = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const lines = (rel) => {
  const s = read(rel);
  if (!s) return 0;
  return s.endsWith('\n') ? s.split('\n').length - 1 : s.split('\n').length;
};

const n = (v) => v.toLocaleString('en-US');

// ── Inventory ────────────────────────────────────────────────────────────────

const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const code = tracked.filter((f) => /\.(ts|tsx)$/.test(f));
const tests = code.filter((f) => /\.test\.tsx?$/.test(f));
const source = code.filter((f) => !/\.test\.tsx?$/.test(f));

const sum = (files) => files.reduce((acc, f) => acc + lines(f), 0);
const sourceLines = sum(source);

// Vitest cases DECLARED: `it(`, `test(`, and their chained forms
// (.each/.skip/.only/.concurrent). This is a floor, not the runtime total — one
// `it.each` declaration expands into a case per table row, and cases built in a
// loop count once here. At the time of writing the declared count was 3,476
// while `vitest run` reported 4,195, so the block says "declared" and never
// claims to be the executed count. Reading the real number would mean running
// (or at least collecting) the suite, which would cost this script its
// no-deps/no-network promise and add ~20s to every version bump.
const testCases = tests.reduce(
  (acc, f) => acc + (read(f).match(/^[ \t]*(it|test)(\.\w+)*(\s*<[^>]*>)?\s*[(`]/gm)?.length ?? 0),
  0,
);

const migrations = tracked.filter((f) => /^packages\/db\/migrations\/.*\.sql$/.test(f));
const docs = tracked.filter((f) => /^docs\/[^/]+\.md$/.test(f)); // engineering docs

// Built-in agent tools: every distinct `slug:` declared in the tools package.
const toolSlugs = new Set();
for (const f of tracked.filter(
  (f) => /^packages\/tools\/src\/.*\.ts$/.test(f) && !/\.test\./.test(f),
)) {
  for (const m of read(f).matchAll(/^\s*slug: '([a-z0-9_]+)',/gm)) toolSlugs.add(m[1]);
}

// System manifest: what a freshly provisioned brain ships with.
const manifest = read('server/web/lib/system-manifest/manifest.ts');
// Entries are counted by their identity key — `slug:` for most, `kind:` for the
// AI workers — at the array's own indent level, so nested option objects don't
// inflate the count.
const manifestCount = (name, key = 'slug') => {
  const from = manifest.indexOf(`export const ${name}`);
  if (from < 0) return 0;
  const to = manifest.indexOf('\n];', from);
  if (to < 0) return 0;
  return manifest.slice(from, to).match(new RegExp(`^ {4}${key}: `, 'gm'))?.length ?? 0;
};

// ── History ──────────────────────────────────────────────────────────────────

const commits = Number(git('rev-list', '--count', 'HEAD'));
const releases = git('tag', '--list', 'v*').split('\n').filter(Boolean).length;
const firstCommit = git('log', '--reverse', '--format=%ad', '--date=short').split('\n')[0];
const days = Math.max(1, Math.round((Date.now() - Date.parse(firstCommit)) / 86_400_000));
const version = JSON.parse(read('package.json')).version;

// Commits per week, as a sparkline — capped at the repo's own age so a young
// repo doesn't render a run of empty weeks before it existed.
const WEEKS = Math.min(26, Math.max(1, Math.ceil(days / 7)));
const weekly = new Array(WEEKS).fill(0);
const weekMs = 7 * 86_400_000;
const now = Date.now();
for (const ts of git('log', '--format=%at', `--since=${WEEKS} weeks ago`)
  .split('\n')
  .filter(Boolean)) {
  const idx = WEEKS - 1 - Math.floor((now - Number(ts) * 1000) / weekMs);
  if (idx >= 0 && idx < WEEKS) weekly[idx]++;
}
const BLOCKS = '▁▂▃▄▅▆▇█';
const peak = Math.max(1, ...weekly);
const sparkline = weekly
  .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / peak) * (BLOCKS.length - 1)))])
  .join('');

// ── Render ───────────────────────────────────────────────────────────────────

const badge = (label, message, color, extra = '') => {
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '--').replace(/_/g, '__');
  return `![${label}](https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}${extra})`;
};

const block = `${START}
<!-- Generated by \`pnpm readme:stats\` — counted from the tree, not typed by hand. -->

${badge('lines of TypeScript', n(sourceLines), '3178c6', '?logo=typescript&logoColor=white')}
${badge('tests', `${n(testCases)}+ declared`, '99424f', '?logo=vitest&logoColor=white')}
${badge('migrations', String(migrations.length), '336791', '?logo=postgresql&logoColor=white')}
${badge('built-in tools', String(toolSlugs.size), '6b4fbb')}
${badge('docs', `${docs.length} guides`, '4c8eda')}
${badge('releases', String(releases), 'blue')}

Counted from this tree on every release. A fresh brain ships with ${manifestCount('MANIFEST_AGENTS')} agents, ${manifestCount('MANIFEST_SKILLS')} skills, ${toolSlugs.size} built-in tools and ${manifestCount('MANIFEST_WORKERS', 'kind')} background AI workers, all on one Postgres database. Test counts are cases *declared*; table-driven tests expand to more when they run.

Version ${version}: ${n(commits)} commits and ${releases} releases since ${firstCommit}, about ${Math.round(commits / days)} commits a day.

\`\`\`
commits/week, last ${WEEKS} weeks   ${sparkline}   peak ${peak}
\`\`\`

${END}`;

// ── Write ────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--print')
    ? 'print'
    : 'write';

if (mode === 'print') {
  console.log(block);
  process.exit(0);
}

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from < 0 || to < 0) {
  console.error(`✗ README.md is missing the ${START} / ${END} markers`);
  process.exit(1);
}
const next = readme.slice(0, from) + block + readme.slice(to + END.length);

if (mode === 'check') {
  if (next !== readme) {
    console.error('✗ README stats are stale — run `pnpm readme:stats` and commit the result.');
    process.exit(1);
  }
  console.log('✔ README stats are current');
  process.exit(0);
}

if (next === readme) {
  console.log('✔ README stats already current');
} else {
  writeFileSync(README, next);
  console.log(
    `✔ README stats updated — ${n(sourceLines)} lines, ${n(testCases)} tests, ${toolSlugs.size} tools, ${n(commits)} commits`,
  );
}

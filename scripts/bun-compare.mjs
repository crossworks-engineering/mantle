#!/usr/bin/env node
/**
 * Bun compare: run the vitest suite on Node and on Bun, and name every test
 * that does worse on Bun.
 *
 *   pnpm bun:compare                       run both, compare to the baseline
 *   pnpm bun:compare --keep <dir>          also keep node.json and bun.json there
 *   pnpm bun:compare --reports <n> <b>     compare two saved reports, run nothing
 *   pnpm bun:compare --write-baseline      write this run's list to the baseline
 *
 * Exit 0: nothing new on Bun. Exit 1: a test does worse than the baseline
 * says. Exit 2: the compare could not run (no report, wrong Bun version).
 *
 * Why: a green start proves little on Bun. It can ignore an option with no
 * error, as it does with undici's `dispatcher`, which turns the connect-time
 * pin in packages/std/src/egress.ts off. Only a test-by-test compare shows
 * that. A test Node runs and Bun does not counts too, so a hang or a file that
 * cannot load does not read as a pass.
 *
 * scripts/bun-baseline.json holds the known list. It may only get shorter:
 * eslint-rules/bun-compare.test.ts pins its ceiling. The Bun version comes from
 * .bun-version. Run this on the workstation or in CI, with both test database
 * URLs set: the Mac can differ (SQLite read-only on a closed WAL file fails
 * there and passes on Linux).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, 'scripts/bun-baseline.json');
const VITEST = 'node_modules/vitest/vitest.mjs';
/** Ends a run that hangs: a real one takes 15 minutes on the workstation. */
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
/** The key of a test file that failed before any of its tests ran. */
const FILE_LEVEL = '<file>';
const NOT_RUN = new Set(['pending', 'skipped', 'todo', 'disabled']);

/**
 * One vitest JSON report as a map of `file > test` to status. Two tests with one
 * name (an `it.each` row) share a key, and a failure wins.
 */
export function readResults(report, root = ROOT) {
  const out = new Map();
  const put = (key, status) => {
    if (out.get(key) !== 'failed') out.set(key, status);
  };
  for (const file of report.testResults ?? []) {
    const name = relative(root, file.name);
    if ((file.assertionResults ?? []).length === 0) {
      put(`${name} > ${FILE_LEVEL}`, file.status);
      continue;
    }
    for (const test of file.assertionResults) {
      put(`${name} > ${test.fullName || test.title}`, test.status);
    }
  }
  return out;
}

/**
 * What Bun does worse. `bunOnly`: failed on Bun, not on Node. `notRun`: passed
 * on Node, and on Bun skipped or gone. A test that fails on Node as well says
 * nothing about Bun, so it is left out.
 */
export function compareRuns(node, bun) {
  const bunOnly = [];
  const notRun = [];
  for (const [key, status] of bun) {
    if (status === 'failed' && node.get(key) !== 'failed') bunOnly.push(key);
  }
  for (const [key, status] of node) {
    if (status !== 'passed') continue;
    const onBun = bun.get(key);
    if (onBun === undefined || NOT_RUN.has(onBun)) notRun.push(key);
  }
  return { bunOnly: bunOnly.sort(), notRun: notRun.sort() };
}

/**
 * This run against the baseline. `fresh`: worse than the baseline says, so the
 * lane is red. `fixed`: a baseline entry that now passes on Bun, to be taken off
 * the list. An entry that did not pass stays, whatever Node did this time.
 */
export function checkBaseline({ bunOnly, notRun }, baseline, bun) {
  const known = new Set(baseline);
  const current = [...bunOnly, ...notRun];
  return {
    fresh: current.filter((key) => !known.has(key)),
    fixed: baseline.filter((key) => bun.get(key) === 'passed'),
  };
}

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

function readReport(path) {
  try {
    return readResults(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    console.error(`bun compare: no usable report at ${path}: ${err.message}`);
    process.exit(2);
  }
}

/** The pinned Bun, or exit 2: a compare on another version says little. */
function assertBunVersion() {
  const wanted = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
  const got = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (got.stdout?.trim() !== wanted) {
    console.error(`bun compare: wants Bun ${wanted}, found ${got.stdout?.trim() || 'none'}`);
    process.exit(2);
  }
  return wanted;
}

/** vitest exits 1 on any failure, which is expected here: the report decides. */
function runSuite(label, command, args, outFile) {
  console.log(`\n--- ${label} ---`);
  const t0 = Date.now();
  const run = spawnSync(
    command,
    [...args, VITEST, 'run', '--reporter=dot', '--reporter=json', `--outputFile.json=${outFile}`],
    { cwd: ROOT, stdio: 'inherit', timeout: RUN_TIMEOUT_MS },
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`${label}: exit ${run.status ?? run.signal}, ${secs}s`);
  return secs;
}

function list(title, keys) {
  if (keys.length === 0) return [];
  return [`${title} (${keys.length}):`, ...keys.map((key) => `  ${key}`)];
}

function summary(compared, verdict, seconds) {
  const lines = [
    `On Bun only: ${compared.bunOnly.length} failed, ${compared.notRun.length} not run.`,
    `Against the baseline: ${verdict.fresh.length} new, ${verdict.fixed.length} fixed.`,
  ];
  if (seconds) lines.push(`Time: Node ${seconds.node}s, Bun ${seconds.bun}s.`);
  return [
    ...lines,
    ...list('New on Bun', verdict.fresh),
    ...list('Fixed on Bun, take these off with --write-baseline', verdict.fixed),
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, at = 1) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + at] : undefined;
  };

  const version = assertBunVersion();
  let nodeFile = value('--reports');
  let bunFile = value('--reports', 2);
  let seconds = null;
  if (!flag('--reports')) {
    const dir = value('--keep') ?? mkdtempSync(join(tmpdir(), 'bun-compare-'));
    mkdirSync(dir, { recursive: true });
    nodeFile = join(dir, 'node.json');
    bunFile = join(dir, 'bun.json');
    seconds = {
      node: runSuite('Node', process.execPath, [], nodeFile),
      bun: runSuite('Bun', 'bun', ['--bun'], bunFile),
    };
  }

  const bun = readReport(bunFile);
  const compared = compareRuns(readReport(nodeFile), bun);
  const baseline = loadBaseline();
  const verdict = checkBaseline(compared, baseline.failures, bun);
  const text = summary(compared, verdict, seconds);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
  }

  if (flag('--write-baseline')) {
    const failures = [...compared.bunOnly, ...compared.notRun].sort();
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ bun: version, failures }, null, 2)}\n`);
    console.log(`\nWrote ${failures.length} entries to scripts/bun-baseline.json`);
    return;
  }
  if (verdict.fresh.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

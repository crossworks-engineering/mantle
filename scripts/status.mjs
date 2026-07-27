#!/usr/bin/env node
// Derived truth about where this repo and its fleet actually stand.
//
// WHY THIS EXISTS. Coordination notes go stale faster than they are read. The
// dev-brain working-memory page carried its own warning — "a stale claim here
// misled a session on 2026-07-26; a stale TASK misled another on 2026-07-27" —
// and on 2026-07-27 a note about unmerged work was 2.5 h old with half of it
// already resolved. Most of what rots is DERIVABLE: which commit is where,
// which branch is unmerged, which box runs which version. What is not
// derivable is intent — decisions, what is waiting on a human, why something
// was parked. Those belong on the page; everything below belongs to a script.
//
// Usage:
//   pnpm status              human-readable
//   pnpm status --json       machine-readable
//   pnpm status --no-fleet   skip the network calls
//
// ─────────────────────────────────────────────────────────────────────────────
// FLEET HOSTS ARE NOT IN THIS FILE, AND MUST NEVER BE. This repo is public;
// hostnames, IPs and client names are operational detail that lives on the dev
// brain. Point the script at your own fleet with either:
//
//   MANTLE_FLEET="dev=https://a.example,prod=https://b.example" pnpm status
//
// or an untracked .mantle-fleet.json at the repo root (see
// .mantle-fleet.example.json). Without either, the fleet section is skipped.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const NO_FLEET = process.argv.includes('--no-fleet');

const git = (args, cwd = ROOT) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};
const ago = (iso) => {
  if (!iso) return '';
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
};

// ── local ────────────────────────────────────────────────────────────────────
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
const upstream =
  git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || 'origin/main';
const counts = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).split(/\s+/);
const [behind, ahead] = [Number(counts[0] || 0), Number(counts[1] || 0)];
const latestTag = git(['describe', '--tags', '--abbrev=0']);
const headTag = git(['tag', '--points-at', 'HEAD']);

// ── worktrees ────────────────────────────────────────────────────────────────
const worktrees = [];
{
  let cur = {};
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9) };
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && cur.path) {
      cur.dirty = git(['status', '--porcelain'], cur.path).split('\n').filter(Boolean).length;
      cur.last = git(['log', '-1', '--format=%cI'], cur.path);
      worktrees.push(cur);
      cur = {};
    }
  }
  if (cur.path) {
    cur.dirty = git(['status', '--porcelain'], cur.path).split('\n').filter(Boolean).length;
    cur.last = git(['log', '-1', '--format=%cI'], cur.path);
    worktrees.push(cur);
  }
}

// ── branches not merged into main (local + every remote) ─────────────────────
const unmerged = [];
for (const ref of ['--no-merged']) {
  for (const spec of [[], ['-r']]) {
    for (const raw of git([
      'branch',
      ...spec,
      ref,
      'main',
      '--format=%(refname:short)|%(committerdate:iso-strict)',
    ])
      .split('\n')
      .filter(Boolean)) {
      const [name, date] = raw.split('|');
      if (!name || name.endsWith('/HEAD') || name === 'main') continue;
      unmerged.push({ name, last: date, age: ago(date) });
    }
  }
}
unmerged.sort((a, b) => (a.last < b.last ? 1 : -1));

// ── fleet ────────────────────────────────────────────────────────────────────
function fleetHosts() {
  const env = process.env.MANTLE_FLEET?.trim();
  if (env) {
    return env
      .split(',')
      .map((p) => {
        const [label, url] = p.split('=');
        return { label: label?.trim(), url: url?.trim() };
      })
      .filter((h) => h.label && h.url);
  }
  const file = join(ROOT, '.mantle-fleet.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed.filter((h) => h?.label && h?.url);
    } catch (e) {
      console.error(`! .mantle-fleet.json is not valid JSON: ${e.message}`);
    }
  }
  return [];
}

async function probe({ label, url }) {
  const ctl = AbortSignal.timeout(8000);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/version`, { signal: ctl });
    if (!res.ok) return { label, url, error: `HTTP ${res.status}` };
    const body = await res.json();
    return {
      label,
      url,
      version: body.version,
      gitSha: (body.gitSha || '').slice(0, 8),
      buildTime: body.buildTime,
    };
  } catch (e) {
    return { label, url, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

const hosts = NO_FLEET ? [] : fleetHosts();
const fleet = hosts.length ? await Promise.all(hosts.map(probe)) : [];

// ── output ───────────────────────────────────────────────────────────────────
const report = {
  local: {
    version,
    branch,
    head,
    dirty,
    upstream,
    ahead,
    behind,
    latestTag,
    headTag: headTag || null,
  },
  worktrees,
  unmerged,
  fleet,
  fleetConfigured: hosts.length > 0,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`\nLOCAL  v${version}  ${branch}@${head}${headTag ? `  (tagged ${headTag})` : ''}`);
console.log(
  `  ${ahead} ahead / ${behind} behind ${upstream}` +
    `${dirty ? `  ·  ${dirty} uncommitted file(s)` : ''}` +
    `${latestTag && latestTag !== headTag ? `  ·  latest tag ${latestTag}` : ''}`,
);
if (ahead > 0) console.log(`  ⚠ ${ahead} commit(s) exist only here — unpushed.`);

if (worktrees.length > 1) {
  console.log('\nWORKTREES');
  for (const w of worktrees) {
    const flag = w.dirty ? `⚠ ${w.dirty} dirty` : 'clean';
    console.log(`  ${pad(w.branch || '(detached)', 42)} ${pad(flag, 12)} ${ago(w.last)} ago`);
  }
}

if (unmerged.length) {
  console.log(`\nNOT IN main  (${unmerged.length})`);
  for (const b of unmerged.slice(0, 20)) console.log(`  ${pad(b.name, 52)} ${b.age} ago`);
  if (unmerged.length > 20) console.log(`  … and ${unmerged.length - 20} more`);
}

if (!hosts.length && !NO_FLEET) {
  console.log(
    '\nFLEET  not configured — set MANTLE_FLEET="label=https://host,…" or create' +
      '\n       .mantle-fleet.json (untracked; see .mantle-fleet.example.json).',
  );
} else if (fleet.length) {
  console.log('\nFLEET');
  for (const f of fleet.sort((a, b) => a.label.localeCompare(b.label))) {
    if (f.error) {
      console.log(`  ${pad(f.label, 14)} ${pad('unreachable', 12)} ${f.error}`);
      continue;
    }
    const drift = f.version === version ? '' : `  (local is v${version})`;
    console.log(`  ${pad(f.label, 14)} ${pad('v' + f.version, 12)} ${f.gitSha}${drift}`);
  }
  const versions = [...new Set(fleet.filter((f) => f.version).map((f) => f.version))];
  if (versions.length > 1) console.log(`  ⚠ fleet is NOT uniform: ${versions.sort().join(', ')}`);
  console.log('  note: /api/version reports the SERVER image; the owner-UI client is a');
  console.log('        second stack — confirm it with `docker ps` on the box.');
}
console.log('');

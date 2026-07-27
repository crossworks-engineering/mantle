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
//   pnpm status --no-fleet   skip the fleet HTTP probes
//   pnpm status --no-peers   skip the other-machine ssh probe
//   pnpm status --local      skip both — pure git, no network
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
// The same file's `peers` entry lists the OTHER dev machines to ask about
// stranded work — also hostnames, also never committed.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const NO_FLEET = process.argv.includes('--no-fleet');
const NO_PEERS = process.argv.includes('--no-peers');
const LOCAL_ONLY = process.argv.includes('--local');

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

// ── config ───────────────────────────────────────────────────────────────────
/** The untracked config may be the original ARRAY of boxes, or an object with
 *  `boxes` and `peers`. Both are accepted so an existing file keeps working. */
function config() {
  const file = join(ROOT, '.mantle-fleet.json');
  if (!existsSync(file)) return { boxes: [], peers: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return { boxes: parsed, peers: [] };
    return { boxes: parsed.boxes ?? [], peers: parsed.peers ?? [] };
  } catch (e) {
    console.error(`! .mantle-fleet.json is not valid JSON: ${e.message}`);
    return { boxes: [], peers: [] };
  }
}

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
  return config().boxes.filter((h) => h?.label && h?.url);
}

/** Dev machines that also hold worktrees — `label=user@host:path`. */
function peerMachines() {
  const env = process.env.MANTLE_PEERS?.trim();
  if (env) {
    return env
      .split(',')
      .map((p) => {
        const [label, rest] = p.split('=');
        const at = rest?.lastIndexOf(':') ?? -1;
        return at < 0
          ? null
          : {
              label: label?.trim(),
              ssh: rest.slice(0, at).trim(),
              path: rest.slice(at + 1).trim(),
            };
      })
      .filter((h) => h?.label && h?.ssh && h?.path);
  }
  return config().peers.filter((h) => h?.label && h?.ssh && h?.path);
}

/**
 * A finished pg-dump fix once sat uncommitted in a worktree on the other
 * machine for two days, invisible from here, and surfaced only because someone
 * happened to write an audit note. It would have died with that worktree. This
 * asks the other machine directly.
 */
async function probePeer({ label, ssh, path }) {
  // One round trip: emit `branch<TAB>dirty<TAB>lastCommitISO` per worktree.
  const remote =
    `cd ${path} 2>/dev/null || exit 3; ` +
    `git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch /{print p"\\t"$2}' | ` +
    `while IFS=$'\\t' read -r p b; do ` +
    `printf '%s\\t%s\\t%s\\t%s\\n' "$b" "$(git -C "$p" status --porcelain | wc -l | tr -d " ")" ` +
    `"$(git -C "$p" log -1 --format=%cI)" "$p"; done`;
  try {
    const out = execFileSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, remote],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 25000 },
    );
    const worktrees = out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [branch, dirty, last] = l.split('\t');
        return {
          branch: (branch || '').replace('refs/heads/', ''),
          dirty: Number(dirty || 0),
          last,
        };
      });
    return { label, worktrees };
  } catch (e) {
    return { label, error: e.status === 3 ? `no repo at ${path}` : 'unreachable' };
  }
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

const hosts = NO_FLEET || LOCAL_ONLY ? [] : fleetHosts();
const machines = NO_PEERS || LOCAL_ONLY ? [] : peerMachines();
const [fleet, peers] = await Promise.all([
  hosts.length ? Promise.all(hosts.map(probe)) : [],
  machines.length ? Promise.all(machines.map(probePeer)) : [],
]);

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
  peers,
  fleetConfigured: hosts.length > 0,
  peersConfigured: machines.length > 0,
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

if (peers.length) {
  console.log('\nOTHER MACHINES');
  for (const p of peers) {
    if (p.error) {
      console.log(`  ${pad(p.label, 14)} ${p.error}`);
      continue;
    }
    const dirty = p.worktrees.filter((w) => w.dirty > 0);
    if (!dirty.length) {
      console.log(`  ${pad(p.label, 14)} ${p.worktrees.length} worktree(s), all clean`);
      continue;
    }
    console.log(`  ${p.label}`);
    for (const w of dirty.sort((a, b) => (a.last < b.last ? -1 : 1))) {
      const age = ago(w.last);
      // A day is the line where "still working on it" becomes "stranded".
      const stale = new Date(w.last).getTime() < Date.now() - 86400000 ? '  ⚠ STRANDED' : '';
      console.log(
        `    ${pad(w.branch, 44)} ${pad(`${w.dirty} dirty`, 10)} ${pad(age + ' ago', 9)}${stale}`,
      );
    }
  }
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

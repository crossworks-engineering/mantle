#!/usr/bin/env node
// runs-on: mac. A dev or operator machine: Node, ssh, nothing else.
//
// fleet-model-check.mjs: does each box run the shipped default model on
// every AI worker and every shipped agent? Read-only: it changes nothing on
// any box.
//
// For each box of .mantle-fleet.json at the repo root with an `ssh` alias
// (untracked, see .mantle-fleet.example.json), it runs
// the box's own check over ssh:
//
//   docker exec mantle_web bun server/web/scripts/model-check.ts --json
//
// so each box is judged against the defaults of the release it runs
// (lib/system-manifest/model-check.ts). The same report is the
// `config_models_check` MCP tool and GET /api/config/models on each box.
// A box on a release before the check says so: roll it first.
//
// Usage:
//   node scripts/fleet-model-check.mjs                 # every box
//   node scripts/fleet-model-check.mjs <label> ...     # these boxes
//   node scripts/fleet-model-check.mjs --json          # one JSON object
//   node scripts/fleet-model-check.mjs --all           # ok rows too
//   node scripts/fleet-model-check.mjs --fleet=<file>  # another fleet file
//
// Output per box: each row not on the default (worker kind or agent slug,
// the box's provider and model, the default's). Model ids and kinds only:
// no client data leaves a box. Exit 0 when every box answered (drift or
// not: it reports, it does not gate), 1 when a box could not be checked.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showAll = args.includes('--all');
const fleetArg = args.find((a) => a.startsWith('--fleet='));
const labels = args.filter((a) => !a.startsWith('--'));

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
const BOX_CMD = 'docker exec mantle_web bun server/web/scripts/model-check.ts --json';

function boxes() {
  const file = fleetArg ? fleetArg.slice('--fleet='.length) : join(ROOT, '.mantle-fleet.json');
  if (!existsSync(file)) {
    console.error(`no ${file}: add the boxes there (see .mantle-fleet.example.json)`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const all = (Array.isArray(raw) ? raw : (raw.boxes ?? [])).filter((b) => b && b.label);
  const picked = labels.length ? all.filter((b) => labels.includes(b.label)) : all;
  for (const l of labels) {
    if (!all.some((b) => b.label === l)) console.error(`! no box labelled "${l}" in ${file}`);
  }
  return picked;
}

/** One box's report, or { error }. */
function checkBox(box) {
  if (!box.ssh) return { error: 'no "ssh" alias in the fleet file' };
  if (!ALIAS.test(box.ssh)) return { error: 'the ssh alias has characters ssh would not take' };
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', box.ssh, BOX_CMD], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.error) return { error: `ssh failed: ${r.error.message}` };
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) {
    const err = (r.stderr ?? '').trim();
    if (/Module not found|Cannot find module|model-check\.ts/.test(err)) {
      return { error: 'this release has no model check: roll the box first' };
    }
    return { error: `exit ${r.status}: ${err.split('\n').slice(-1)[0] ?? ''}` };
  }
  const line = out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  try {
    return { report: JSON.parse(line ?? '') };
  } catch {
    return { error: 'the box did not answer with a report' };
  }
}

function route(r) {
  if (!r) return '(none)';
  const extra = Object.entries(r.paramModels ?? {})
    .map(([k, v]) => ` ${k}=${v}`)
    .join('');
  return `${r.provider} / ${r.model}${extra}`;
}

const results = {};
let failed = 0;
for (const box of boxes()) {
  const res = checkBox(box);
  results[box.label] = res;
  if (res.error) failed++;
  if (asJson) continue;
  if (res.error) {
    console.log(`\n✗ ${box.label}: ${res.error}`);
    continue;
  }
  const { appVersion, notOk, rows } = res.report;
  console.log(`\n${notOk ? '!' : '✓'} ${box.label} (v${appVersion}): ${notOk} not on the default`);
  for (const r of rows) {
    if (r.status === 'ok' && !showAll) continue;
    const what = r.kind === 'worker' ? `worker ${r.name}` : `agent ${r.name}`;
    console.log(`    ${r.status.padEnd(7)} ${what.padEnd(28)} box: ${route(r.box)}`);
    if (r.status !== 'ok') console.log(`    ${''.padEnd(36)} default: ${route(r.default)}`);
  }
}
if (asJson) console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);

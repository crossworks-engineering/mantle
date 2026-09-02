#!/usr/bin/env node
/**
 * docs-check — every repo path a live doc names must exist.
 *
 * Walks the live docs (docs/** minus _archive and _changelog, plus README.md,
 * PRODUCT.md and every CLAUDE.md) and checks two things:
 *   1. backticked repo paths (`server/web/lib/x.ts`, `packages/db/…`,
 *      `scripts/foo.sh`, `docs/bar.md`, `infra/…`, `.github/…`) resolve on
 *      disk (a trailing `:line` or `#anchor` is ignored; globs are skipped);
 *   2. relative markdown links (`[x](../docs/y.md)`, `[x](y.md#h)`) resolve.
 *
 * Why (2026-09-02 audit, gap D7): after the frontend split the docs carried
 * hundreds of paths that no longer existed, including in the doc README
 * calls "read before touching code", and eight docs pointed at a
 * docs/db-less-dev.md that had never been written. Docs are also indexed
 * into the brain, so a dead path there misleads the assistant, not just a
 * reader. Runs in build-check; `pnpm docs:check` locally.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
// diagram-guides is vendored from the diagramming skill; its cross-references
// name sibling files and scripts that skill never shipped here.
const SKIP_DIRS = new Set(['_archive', '_changelog', 'node_modules', 'diagram-guides']);
const REPO_PREFIX = /^(server|packages|scripts|docs|infra|eslint-rules|\.github|brand)\//;

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.name.endsWith('.md')) out.push(join(dir, e.name));
  }
  return out;
}
function claudeFiles(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) claudeFiles(join(dir, e.name), out);
    } else if (e.name === 'CLAUDE.md') out.push(join(dir, e.name));
  }
  return out;
}

const files = [
  ...walk(join(root, 'docs'), []),
  ...['README.md', 'PRODUCT.md'].map((f) => join(root, f)).filter(existsSync),
  ...claudeFiles(root, []),
];

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(root.length + 1);
  // 1. backticked repo paths
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    let p = m[1].trim();
    if (!REPO_PREFIX.test(p)) continue;
    if (/[*{}<>$ \u2026]/u.test(p)) continue; // glob / placeholder / prose (incl. an ellipsis)
    if (/(^|\/)\.env[^/]*$/.test(p)) continue; // local env files are never committed
    p = p.replace(/[:#][^/]*$/, ''); // `:line`, `#anchor`
    p = p.replace(/\/$/, '');
    if (!existsSync(join(root, p))) problems.push(`${rel}: \`${m[1]}\` does not exist`);
  }
  // 2. relative markdown links
  for (const m of text.matchAll(/\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g)) {
    const target = m[1].replace(/\\([()])/g, '$1');
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    const clean = target.replace(/[#?].*$/, '').replace(/:\d+$/, '');
    if (!clean || /[*{}<>$]/.test(clean)) continue;
    if (!/[./]/.test(clean)) continue; // a bare word such as (url) is a placeholder
    if (/(^|\/)jackdaw\//.test(clean)) continue; // the frontend repo: not checkable here
    const abs = resolve(dirname(file), clean);
    if (!existsSync(abs)) problems.push(`${rel}: link (${target}) does not resolve`);
  }
}

if (problems.length) {
  console.error(`docs-check: ${problems.length} problem(s) in ${files.length} files\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`docs-check: ${files.length} files, every referenced path exists`);

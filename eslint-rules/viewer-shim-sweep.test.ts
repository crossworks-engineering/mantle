import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isSwept } from './level-reads.mjs';

/**
 * The R6 sweep (workspaces plan R6, S2, T4; phase W5b2): every caller of
 * withViewer says whom it acts for, and no product code reaches a level
 * role any other way. withViewer builds a WORKSPACE scope from that (a
 * login's workspaces, an assistant's workspace, a link's served list): the
 * old level roles serve only personal spaces (until W6b) and
 * withHumanViewer (the review flows, until W5c), both inside
 * packages/db/src/client.ts. The runtime half (what each scope reads) is
 * packages/db/src/viewer-shim.db.test.ts.
 */
const ROOT = join(__dirname, '..');

function sweptFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', 'packages', 'server', 'scripts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter((f: string) => isSwept(f) && /\.(ts|tsx|mjs|js)$/.test(f));
}

/** The file's code: comments and double-quoted strings blanked (they may
 *  name withViewer in prose). */
function read(f: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    return null; // listed by git, deleted in the working tree
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** The text of every call `name(...)` in `text`, parentheses balanced. */
function calls(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A declaration, not a call.
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

const CLIENT = 'packages/db/src/client.ts';
const VIEWER = 'packages/db/src/viewer.ts';

describe('the withViewer shim sweep (R6)', () => {
  it('every withViewer call names whom it acts for', () => {
    const bad: string[] = [];
    for (const f of sweptFiles()) {
      if (f === CLIENT || f === VIEWER) continue;
      const text = read(f);
      if (!text) continue;
      for (const c of calls(text, 'withViewer')) {
        // withViewer(level, { login | agent | link: ... }, fn)
        if (!/^withViewer\(\s*[^,]+,\s*\{\s*(login|agent|link)\s*:/.test(c)) {
          bad.push(`${f}: ${c.slice(0, 80).replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(bad, 'pass { login }, { agent } or { link } as the second argument').toEqual([]);
  });

  it('no product code enters a level role outside the two kept paths', () => {
    const bad: string[] = [];
    for (const f of sweptFiles()) {
      const text = read(f);
      if (!text) continue;
      // The test-only level runner never reaches product code.
      if (
        /\brunInLevelRoleForTest\b/.test(text) &&
        f !== VIEWER &&
        !f.endsWith('test-support.ts')
      ) {
        if (f !== 'packages/db/src/index.ts') bad.push(`${f}: runInLevelRoleForTest`);
      }
      if (f === CLIENT || f === VIEWER) continue;
      for (const name of ['runInTxScope', 'getViewerDb', 'runInLevelRoleForTest']) {
        if (calls(text, name).length) bad.push(`${f}: ${name}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('in client.ts a level pool is opened only by getDb, withSpace and withHumanViewer', () => {
    const text = read(CLIENT)!;
    const levelPools = calls(text, 'getViewerDb').filter(
      (c) => !/getViewerDb\('(user|space)'\)/.test(c),
    );
    // getDb (a level scope already entered by the two paths below) and
    // withHumanViewer's own transaction.
    expect(levelPools.map((c) => c.replace(/\s+/g, ' '))).toEqual([
      'getViewerDb(level)',
      'getViewerDb(effective)',
    ]);
    const entries = calls(text, 'runInTxScope').map((c) => c.replace(/\s+/g, ' '));
    expect(entries).toEqual([
      'runInTxScope({ level, space: { ...scope }, tx, hooks }, fn)',
      'runInTxScope({ level: effective, tx }, fn)',
    ]);
  });

  it('in viewer.ts only the test runner enters a bare level scope', () => {
    const text = read(VIEWER)!;
    const bare = calls(text, 'store.run').filter((c) =>
      /^store\.run\(\{\s*level: next\s*\}/.test(c),
    );
    expect(bare).toHaveLength(1);
    const fn = text.slice(text.indexOf('export function runInLevelRoleForTest'));
    expect(fn.indexOf('store.run({ level: next }')).toBeGreaterThan(0);
  });
});

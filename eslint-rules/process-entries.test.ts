import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The process inventory is pinned (workspaces arch plan v2, section 4.3;
 * A2a): every file that starts work on its own (a queue consumer, a worker
 * shell, a DBOS workflow, a LISTEN, an interval timer) is listed in the
 * `entries` block of docs/actors.md, kind by kind, with the actor it binds.
 * A new one fails here until the doc names it and its actor.
 */
const ROOT = join(__dirname, '..');

/** The kinds of entry, and the code that starts each. */
const KINDS: Record<string, RegExp> = {
  'queue-work': /\bboss\.work\(|\.work\(\s*(QUEUE|[A-Z_]+_QUEUE|queue)\b/,
  'worker-shell': /\brunQueueWorker\(|\brunWorker\(/,
  'dbos-workflow': /\bDBOS\.(registerWorkflow|workflow)\b/,
  listen: /\.listen\(/,
  interval: /\bsetInterval\(/,
  'request-slot': /\brunInRequestSlot\(|\brunInActorSlot\(/,
};

function productFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'packages', 'server'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (
    out
      .split('\n')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !/\.test\.tsx?$|\.d\.ts$|\/scripts\/|\.gen\.ts$/.test(f))
      // packages/db defines the entry helpers (runInActorSlot, the request
      // slot); it starts nothing on its own.
      .filter((f) => !f.startsWith('packages/db/src/'))
  );
}

/** `<kind> <file>` for every file holding an entry of that kind. */
function found(): string[] {
  const rows: string[] = [];
  for (const f of productFiles()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    // Comments do not start work.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const [kind, re] of Object.entries(KINDS)) {
      if (re.test(code)) rows.push(`${kind} ${f}`);
    }
  }
  return rows.sort();
}

/** The doc's `entries` block. */
function pinned(): string[] {
  const doc = readFileSync(join(ROOT, 'docs/actors.md'), 'utf8');
  const m = /```entries\n([\s\S]*?)```/.exec(doc);
  if (!m) throw new Error('docs/actors.md has no entries block');
  return m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/).slice(0, 2).join(' '))
    .sort();
}

describe('the process inventory (docs/actors.md)', () => {
  it('lists every file that starts work on its own, kind by kind', () => {
    const want = pinned();
    const have = found();
    const missing = have.filter((r) => !want.includes(r));
    const stale = want.filter((r) => !have.includes(r));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('names the actor of each entry', () => {
    const doc = readFileSync(join(ROOT, 'docs/actors.md'), 'utf8');
    const block = /```entries\n([\s\S]*?)```/.exec(doc)![1]!;
    for (const line of block.split('\n').map((l) => l.trim())) {
      if (!line || line.startsWith('#')) continue;
      expect(line.split(/\s+/).length, line).toBeGreaterThanOrEqual(3);
    }
  });
});

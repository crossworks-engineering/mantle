import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTOR_BINDER_PINS, binderSites } from './actor-binders.mjs';

/**
 * The process inventory is pinned (workspaces arch plan v2, section 4.3;
 * A2a): every file that starts work on its own (a queue consumer, a worker
 * shell, a DBOS workflow, a LISTEN, an interval timer, a timeout loop, a
 * process event handler) is listed in the `entries` block of
 * docs/process-inventory.md, kind by kind, with the actor it binds. A new
 * one fails here until the doc names it and its actor. packages/db/src is
 * scanned too: a file there that only defines a helper says so.
 *
 * The kinds are text heuristics over code with comments removed:
 *
 *  - queue-work: a pg-boss consumer (`boss.work(`, `.work(QUEUE`,
 *    `.work<T>(`).
 *  - worker-shell: runQueueWorker / runWorker.
 *  - dbos-workflow: DBOS.registerWorkflow / DBOS.workflow, and
 *    registerActorWorkflow (the one way a workflow registers, below).
 *  - listen: `.listen(`. interval: `setInterval(`.
 *  - request-slot: runInRequestSlot / runInActorSlot.
 *  - timeout-loop: `setTimeout(` in a file that also reaches the database
 *    (a value import from @mantle/db, or a file of packages/db/src). A
 *    timer that re-arms itself is a loop with no entry around it, and text
 *    cannot tell a re-arming timer from a sleep or a deadline, so every such
 *    file is pinned and the doc says which it is.
 *  - process-on: `process.on(` (signal and rejection handlers).
 *
 * A file nobody tracks yet (new, not yet committed) is scanned too, so a new
 * entry is caught before its first commit.
 */
const ROOT = join(__dirname, '..');
/** The doc whose `entries` block lists every process entry. */
const INVENTORY = 'docs/process-inventory.md';

const DB_IMPORT = /\bimport\s+(?!type\b)[^;]*?\bfrom\s+['"]@mantle\/db['"]/;

/** The kinds of entry, and the code that starts each. */
const KINDS: Record<string, (code: string, file: string) => boolean> = {
  'queue-work': (c) =>
    /\bboss\.work\(|\.work\(\s*(QUEUE|[A-Z_]+_QUEUE|queue)\b|\.work<[^>]*>\(/.test(c),
  'worker-shell': (c) => /\brunQueueWorker\(|\brunWorker\(/.test(c),
  'dbos-workflow': (c) => /\bDBOS\.(registerWorkflow|workflow)\b|\bregisterActorWorkflow\(/.test(c),
  listen: (c) => /\.listen\(/.test(c),
  interval: (c) => /\bsetInterval\(/.test(c),
  'request-slot': (c) => /\brunInRequestSlot\(|\brunInActorSlot\(/.test(c),
  'timeout-loop': (c, f) =>
    /\bsetTimeout\(/.test(c) && (f.startsWith('packages/db/src/') || DB_IMPORT.test(c)),
  'process-on': (c) => /\bprocess\.on\(/.test(c),
};

/** Product files: tracked, or new and not ignored. */
function productFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'packages', 'server'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [
    ...new Set(
      out
        .split('\n')
        .filter((f) => /\.(ts|tsx)$/.test(f))
        .filter((f) => !/\.test\.tsx?$|\.d\.ts$|\/scripts\/|\.gen\.ts$/.test(f)),
    ),
  ].sort();
}

/** A product file's text, or null when git lists it but the tree has none. */
function read(f: string): string | null {
  try {
    return readFileSync(join(ROOT, f), 'utf8');
  } catch {
    return null;
  }
}

/** Code with comments removed: comments do not start work. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `<kind> <file>` for every file holding an entry of that kind. */
function found(): string[] {
  const rows: string[] = [];
  for (const f of productFiles()) {
    const text = read(f);
    if (text === null) continue;
    const code = codeOf(text);
    for (const [kind, holds] of Object.entries(KINDS)) {
      if (holds(code, f)) rows.push(`${kind} ${f}`);
    }
  }
  return rows.sort();
}

/** The doc's `entries` block. */
function pinned(): string[] {
  const doc = readFileSync(join(ROOT, INVENTORY), 'utf8');
  const m = /```entries\n([\s\S]*?)```/.exec(doc);
  if (!m) throw new Error(`${INVENTORY} has no entries block`);
  return m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/).slice(0, 2).join(' '))
    .sort();
}

describe('the process inventory (docs/process-inventory.md)', () => {
  it('lists every file that starts work on its own, kind by kind', () => {
    const want = pinned();
    const have = found();
    const missing = have.filter((r) => !want.includes(r));
    const stale = want.filter((r) => !have.includes(r));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('names the actor of each entry', () => {
    const doc = readFileSync(join(ROOT, INVENTORY), 'utf8');
    const block = /```entries\n([\s\S]*?)```/.exec(doc)![1]!;
    for (const line of block.split('\n').map((l) => l.trim())) {
      if (!line || line.startsWith('#')) continue;
      expect(line.split(/\s+/).length, line).toBeGreaterThanOrEqual(3);
    }
  });

  it('every entry that binds a login runs in a process that opens the login write pool', () => {
    // A process that never calls openLoginWritePool sends a login's scoped
    // writes to the system pool (gateway/write-route.ts loginWriteRoute).
    // The process of an entry: a worker file is its own process, any other
    // file of a server its server's main file; a package file runs in its
    // caller's process.
    const processOf = (f: string): string | null => {
      if (/^server\/web\/workers\/[^_/][^/]*\.ts$/.test(f)) return f;
      if (f.startsWith('server/web/')) return 'server/web/server/main.ts';
      if (f.startsWith('server/api/')) return 'server/api/src/main.ts';
      if (f.startsWith('server/mcp/')) return 'server/mcp/src/server.ts';
      return null;
    };
    const doc = readFileSync(join(ROOT, INVENTORY), 'utf8');
    const block = /```entries\n([\s\S]*?)```/.exec(doc)![1]!;
    const closed: string[] = [];
    for (const line of block.split('\n').map((l) => l.trim())) {
      if (!line || line.startsWith('#')) continue;
      const [, file, ...rest] = line.split(/\s+/);
      const actor = rest.join(' ');
      if (!/\blogin\b/.test(actor) || actor.startsWith('defines the helper')) continue;
      const main = processOf(file!);
      const code = main === null ? null : read(main);
      if (code === null || !/\bopenLoginWritePool\(/.test(codeOf(code))) closed.push(line);
    }
    expect(closed).toEqual([]);
  });

  it('every DBOS workflow registers through registerActorWorkflow', () => {
    // The API boot binds no actor, so a workflow registered straight on DBOS
    // would run with none. Only the helper itself registers directly, and
    // crash-test.ts: a manual harness run by hand on scratch databases,
    // never imported by the runner (main.ts) nor run on a box.
    const direct = productFiles().filter((f) => {
      const text = read(f);
      return text !== null && /\bDBOS\.(registerWorkflow|workflow)\b/.test(codeOf(text));
    });
    expect(direct).toEqual([
      'server/api/src/crash-test.ts',
      'server/api/src/workflows/actor-workflow.ts',
    ]);
    const main = readFileSync(join(ROOT, 'server/api/src/main.ts'), 'utf8');
    expect(main).not.toMatch(/crash-test/);
  });
});

describe('the actor binders (eslint-rules/actor-binders.mjs)', () => {
  it('pins every binder call, per file, exactly', () => {
    const have: Record<string, number> = {};
    for (const f of productFiles()) {
      const text = read(f);
      if (text === null) continue;
      const n = binderSites(text);
      if (n > 0) have[f] = n;
    }
    expect(have).toEqual(ACTOR_BINDER_PINS);
  });

  it('counts calls only: not comments, not the helpers themselves', () => {
    const text = [
      'export function runAsActor<T>(actor: Actor, fn: () => T): T {',
      '  return actorStore.run(actor, () => startedInside(fn()));',
      '}',
      "// runAsSystem('x', f)",
      '/* runAsActor(a, f) */',
      "runAsSystem('worker:x', start);",
      'runInActorSlot<Foo>(initial, fn);',
      'actorStore.enterWith(TEST_ACTOR);',
    ].join('\n');
    expect(binderSites(text)).toBe(4);
  });

  it('counts the slot setters, runWithoutActor and nested type arguments (fix round 2, L7)', () => {
    const text = [
      'export function setSlotActor(actor: Actor): void {}',
      'setSlotActor(loginActor(id));',
      "setRequestActor({ kind: 'link' });",
      'runWithoutActor(() => refresh(sql));',
      "runAsSystem<Array<Row>>('worker:x', fn);",
      "runAsSystem<Map<string, Array<Row>>>('worker:x', fn);",
    ].join('\n');
    expect(binderSites(text)).toBe(5);
  });

  it('counts the exit helper runSystemExit: each exit through it binds an actor', () => {
    const text = [
      'function runSystemExit<T>(entry: E, actor: Actor, fn: () => Promise<T>): Promise<T> {',
      '  return systemRoutes.run(entry, () => runAsActor(actor, fn));',
      '}',
      '// runSystemExit(entry, actor, fn)',
      'return runSystemExit(entry, systemActor(reason), fn);',
      'const run = () => runSystemExit<number>(entry, actor, fn);',
    ].join('\n');
    expect(binderSites(text)).toBe(3);
  });
});

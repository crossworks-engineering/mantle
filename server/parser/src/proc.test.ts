/**
 * The parser's one child-process primitive (./proc.ts): the deadline is
 * absolute, whatever the child leaves behind. What is pinned:
 *  - a child that exits is reported with its code and its output;
 *  - the deadline kills the group and settles, and so does an abort, also
 *    one that came before the child started;
 *  - a descendant that left the group (a new session, as setsid makes) and
 *    holds the output pipes open cannot hold the promise: it settles within
 *    the grace after the leader exits, at the deadline or on its own;
 *  - a reader's child gets a minimal environment, never the parser's token;
 *  - a job's own child (started in the job's group, as runChild does) dies
 *    with the job; one that left the group (setsid) survives it, which is
 *    what the check after every job is for (./clean.test.ts);
 *  - a job's temp files, home and caches sit in its own directory, and tsx
 *    keeps no cache.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_GRACE_MS, childEnv, jobEnv, runGroup } from './proc';

const NODE = process.execPath;
const left: number[] = [];

afterEach(() => {
  for (const pid of left.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** A node one-liner that starts a child in a NEW session (detached is
 *  setsid on POSIX) holding this process's stdout and stderr, prints its
 *  pid, then does `then`. */
function escapee(then: string): string[] {
  return [
    '-e',
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
     process.stdout.write('pid ' + c.pid + '\\n');
     ${then}`,
  ];
}

/** A node one-liner that starts a child in ITS OWN group (as runChild
 *  does: no setsid), prints its pid, then does `then`. */
function groupChild(then: string): string[] {
  return [
    '-e',
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
     process.stdout.write('pid ' + c.pid + '\\n');
     ${then}`,
  ];
}

/** Whether `pid` still runs (a zombie waiting for its reaper counts as
 *  gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function pidOf(stdout: string): number {
  const pid = Number(/pid (\d+)/.exec(stdout)?.[1]);
  if (Number.isInteger(pid)) left.push(pid);
  return pid;
}

describe('runGroup', () => {
  it('reports an exit with its code and output', async () => {
    const ended = await runGroup(NODE, ['-e', 'process.stdout.write("hi"); process.exit(3)'], {
      timeoutMs: 10_000,
      stdout: true,
    });
    expect(ended).toMatchObject({ code: 3, timedOut: false, stdout: 'hi', spawnError: null });
  });

  it('kills the group at the deadline and settles', async () => {
    const started = Date.now();
    const ended = await runGroup(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
    expect(ended.timedOut).toBe(true);
    expect(ended.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(200 + EXIT_GRACE_MS + 1_000);
  });

  it('settles at the deadline though an escaped descendant holds the pipes', async () => {
    const started = Date.now();
    const ended = await runGroup(NODE, escapee('setTimeout(() => {}, 60000);'), {
      timeoutMs: 500,
      stdout: true,
    });
    const pid = pidOf(ended.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(ended.timedOut).toBe(true);
    // Settled by the deadline plus the grace, not by the descendant's minute.
    expect(Date.now() - started).toBeLessThan(500 + EXIT_GRACE_MS + 1_500);
  });

  it('settles on the leader’s exit though an escaped descendant holds the pipes', async () => {
    const started = Date.now();
    const ended = await runGroup(NODE, escapee('process.exit(0);'), {
      timeoutMs: 30_000,
      stdout: true,
    });
    pidOf(ended.stdout);
    expect(ended).toMatchObject({ code: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(EXIT_GRACE_MS + 2_000);
  });

  it('kills at once on an abort, also one that came before the start', async () => {
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const ended = await runGroup(NODE, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 30_000,
      abort: abort.signal,
    });
    expect(ended.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);

    const later = new AbortController();
    const run = runGroup(NODE, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 30_000,
      abort: later.signal,
    });
    setTimeout(() => later.abort(), 100);
    expect((await run).code).not.toBe(0);
  });

  it('reports a program that cannot start', async () => {
    const ended = await runGroup('/nonexistent/program', [], { timeoutMs: 5_000 });
    expect(ended.spawnError).toBeTruthy();
  });
});

describe('childEnv', () => {
  it('gives a child its own small environment, never the parser’s token', async () => {
    process.env.PARSER_TOKEN = 'secret-token';
    try {
      const env = childEnv('/tmp/job', { MPLBACKEND: 'Agg' });
      expect(env.PARSER_TOKEN).toBeUndefined();
      expect(env).toMatchObject({ TMPDIR: '/tmp/job', HOME: '/tmp/job', MPLBACKEND: 'Agg' });
      const ended = await runGroup(
        NODE,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        {
          timeoutMs: 10_000,
          stdout: true,
          env,
        },
      );
      const seen = JSON.parse(ended.stdout) as Record<string, string>;
      expect(seen.PARSER_TOKEN).toBeUndefined();
      expect(seen.TMPDIR).toBe('/tmp/job');
    } finally {
      delete process.env.PARSER_TOKEN;
    }
  });
});

describe('a job and what it leaves', () => {
  it('a job’s own child (in the job’s group) dies with the job', async () => {
    const ended = await runGroup(NODE, groupChild('process.exit(0);'), {
      timeoutMs: 30_000,
      stdout: true,
    });
    const pid = pidOf(ended.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(await goneWithin(pid, 3_000)).toBe(true);
  });

  it('a job’s own child dies with the job at its deadline too', async () => {
    const ended = await runGroup(NODE, groupChild('setTimeout(() => {}, 60000);'), {
      timeoutMs: 500,
      stdout: true,
    });
    expect(ended.timedOut).toBe(true);
    expect(await goneWithin(pidOf(ended.stdout), 3_000)).toBe(true);
  });

  it('a grandchild that left the job’s group (setsid) survives the group kill', async () => {
    // What the check after every job finds (./clean.ts): the group kill
    // cannot reach it, so the container is restarted.
    const ended = await runGroup(NODE, escapee('process.exit(0);'), {
      timeoutMs: 30_000,
      stdout: true,
    });
    const pid = pidOf(ended.stdout);
    expect(alive(pid)).toBe(true);
  });
});

describe('jobEnv', () => {
  it('keeps a job’s state in its own directory, with no token and no tsx cache', () => {
    process.env.PARSER_TOKEN = 'secret-token';
    try {
      const env = jobEnv('/work/job-1/tmp');
      expect(env.PARSER_TOKEN).toBeUndefined();
      expect(env).toMatchObject({
        TMPDIR: '/work/job-1/tmp',
        HOME: '/work/job-1/tmp',
        XDG_CACHE_HOME: '/work/job-1/tmp/.cache',
        MPLCONFIGDIR: '/work/job-1/tmp/.mpl',
        TSX_DISABLE_CACHE: '1',
      });
    } finally {
      delete process.env.PARSER_TOKEN;
    }
  });
});

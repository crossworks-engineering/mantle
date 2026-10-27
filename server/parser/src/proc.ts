/**
 * One child process with a hard deadline: started in its OWN process group,
 * so the deadline's SIGKILL takes the whole group (a job's Python CAD child,
 * ffmpeg under ffprobe), never just the leader. The container runs with
 * `init: true`, so a reparented grandchild is reaped by tini.
 *
 * The deadline is absolute. The promise settles when the child EXITS, not
 * when its output pipes close: a descendant that left the group (setsid)
 * would hold the pipes open for as long as it runs, and with them the job's
 * slot. After the exit (or the kill) the tail of the output gets a short
 * grace, then the pipes are destroyed and the promise settles.
 *
 * How it ended is reported, never thrown: the caller maps it to the wire's
 * error codes.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { envDynamic } from '@mantle/config';

export type Ended = {
  /** Exit code, or null when a signal ended it. */
  code: number | null;
  /** The signal that ended it, when one did. */
  signal: NodeJS.Signals | null;
  /** The deadline passed and this module killed the group. */
  timedOut: boolean;
  /** The last bytes the child wrote to stderr. */
  stderr: string;
  /** The first bytes it wrote to stdout, when asked for (`stdout: true`). */
  stdout: string;
  /** The child could not be started at all. */
  spawnError: string | null;
};

const STDERR_TAIL = 4096;
const STDOUT_HEAD = 64 * 1024;
/** How long the output pipes may stay open after the child exited, or after
 *  the deadline's kill when no exit came. */
export const EXIT_GRACE_MS = 1_000;

/**
 * The environment a reader's child program gets: enough to run, nothing of
 * the parser's own (no token, no settings). `extra` adds what one program
 * needs (Python's backend, its bytecode switch).
 */
export function childEnv(tmpdir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: envDynamic('PATH') ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpdir,
    TMPDIR: tmpdir,
    LANG: 'C.UTF-8',
    ...extra,
  };
}

export function runGroup(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    cwd?: string;
    /** The child's whole environment (see {@link childEnv}); nothing is
     *  inherited from the parser when it is given. */
    env?: NodeJS.ProcessEnv;
    abort?: AbortSignal;
    /** Keep the first 64 KB of stdout (a version line, a duration). */
    stdout?: boolean;
  },
): Promise<Ended> {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let settled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // Never the working directory as HOME: a program's caches would land in
      // the source tree.
      env: opts.env ?? childEnv(opts.cwd ?? os.tmpdir()),
      detached: true,
      stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const done = (ended: Ended) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.abort?.removeEventListener('abort', onAbort);
      // A job that exited may have left a child of its own running.
      killGroup();
      // A descendant outside the group may still hold the pipes: stop
      // listening, so nothing of this child outlives the settle.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(ended);
    };
    const settleSoon = () => {
      if (grace || settled) return;
      grace = setTimeout(
        () =>
          done({
            code: exited?.code ?? null,
            signal: exited?.signal ?? (timedOut ? 'SIGKILL' : null),
            timedOut,
            stderr,
            stdout,
            spawnError: null,
          }),
        EXIT_GRACE_MS,
      );
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // The kill is sent: whether or not an exit is ever seen, the answer
      // comes within the grace.
      settleSoon();
    }, opts.timeoutMs);
    // The caller gave up (the client went away): the group goes too.
    const onAbort = () => killGroup();
    if (opts.abort?.aborted) killGroup();
    else opts.abort?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_HEAD)
        stdout = (stdout + chunk.toString('utf8')).slice(0, STDOUT_HEAD);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) =>
      done({ code: null, signal: null, timedOut, stderr, stdout, spawnError: err.message }),
    );
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // The group goes now, so nothing it started keeps the pipes open.
      killGroup();
      settleSoon();
    });
    // The pipes closed (the usual end): settle at once with the whole output.
    child.on('close', (code, signal) => {
      exited ??= { code, signal };
      done({
        code: exited.code,
        signal: exited.signal,
        timedOut,
        stderr,
        stdout,
        spawnError: null,
      });
    });
  });
}

/** The process ids of this process and its ancestors (Linux /proc). */
async function ancestors(): Promise<Set<number>> {
  const out = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !out.has(pid)) {
    out.add(pid);
    const ppid = await parentOf(pid);
    if (ppid === null) break;
    pid = ppid;
  }
  return out;
}

async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid ...": comm may hold spaces and parens, so read
    // after the LAST ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Kill every process that a job left behind: in the parser's container, a
 * process whose parent is PID 1 (tini) and that is not this server or one of
 * its ancestors is an orphan of a job (a reader's child that escaped its
 * group with setsid). It would keep a CPU and memory a later job needs. Only
 * inside the container (PID 1 is docker's init): on a host, PID 1's children
 * are the host's own services. Returns how many it killed.
 */
export async function reapOrphans(): Promise<number> {
  if (process.platform !== 'linux') return 0;
  let init: string;
  try {
    init = (await fs.readFile('/proc/1/comm', 'utf8')).trim();
  } catch {
    return 0;
  }
  if (init !== 'docker-init' && init !== 'tini') return 0;
  const keep = await ancestors();
  let killed = 0;
  for (const name of await fs.readdir('/proc').catch(() => [] as string[])) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || keep.has(pid)) continue;
    if ((await parentOf(pid)) !== 1) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      /* gone already */
    }
  }
  return killed;
}

/**
 * The parser's child processes, with a hard deadline each.
 *
 * Two kinds. The server starts each JOB in its OWN process group
 * ({@link runGroup}): the deadline's SIGKILL takes the whole group. Inside
 * a job, a reader's child program (the Python CAD child, ffprobe, ffmpeg)
 * is started in the JOB's group ({@link runChild}), never a group of its
 * own: when the job ends or is killed, the server's group kill takes the
 * child and anything the child started with it. A process that left the
 * group on purpose (setsid) survives that kill: the server's check after
 * every job finds it, and the container is restarted (./clean.ts).
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
import os from 'node:os';
import path from 'node:path';
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

/**
 * A job process's environment: the parser's own, less its bearer token (a
 * job never talks to anything; a reader broken out of its document must not
 * find the token), with every place a program keeps state between runs
 * inside the job's own directory, which goes with the job: its temp files
 * (TMPDIR), its home and caches (HOME, XDG_CACHE_HOME), matplotlib's
 * config and font cache (MPLCONFIGDIR). tsx keeps no transform cache
 * (TSX_DISABLE_CACHE): its default sits in the shared /tmp, where one job
 * could leave a module for the next.
 */
export function jobEnv(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PARSER_TOKEN;
  return {
    ...env,
    TMPDIR: scratch,
    HOME: scratch,
    XDG_CACHE_HOME: path.join(scratch, '.cache'),
    MPLCONFIGDIR: path.join(scratch, '.mpl'),
    TSX_DISABLE_CACHE: '1',
  };
}

type RunOpts = {
  timeoutMs: number;
  cwd?: string;
  /** The child's whole environment (see {@link childEnv}); nothing is
   *  inherited from the parser when it is given. */
  env?: NodeJS.ProcessEnv;
  abort?: AbortSignal;
  /** Keep the first 64 KB of stdout (a version line, a duration). */
  stdout?: boolean;
  /** Told the child's pid once it started: a job's process group (the
   *  server kills it again, and checks it is gone, after the job). */
  onSpawn?: (pid: number) => void;
};

/** A job (or a short probe) in its own process group: the deadline, an
 *  abort and the end each kill the whole group. */
export function runGroup(command: string, args: string[], opts: RunOpts): Promise<Ended> {
  return run(command, args, opts, true);
}

/** A reader's child program, inside a job: in the job's own group, so the
 *  server's kill of the job takes it. Its own deadline kills the child. */
export function runChild(command: string, args: string[], opts: RunOpts): Promise<Ended> {
  return run(command, args, opts, false);
}

function run(command: string, args: string[], opts: RunOpts, group: boolean): Promise<Ended> {
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
      // A group of its own (setsid) for a job; a reader's child stays in
      // its job's group.
      detached: group,
      stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    let exitSeen = false;
    // A job: its whole group. A reader's child: the child alone, and only
    // while it has not exited (its pid could be someone else's after).
    const killGroup = () => {
      if (child.pid === undefined) return;
      if (!group && exitSeen) return;
      try {
        process.kill(group ? -child.pid : child.pid, 'SIGKILL');
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
      if (!group) exitSeen = true;
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

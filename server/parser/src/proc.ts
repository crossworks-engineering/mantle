/**
 * The parser's child processes, with a hard deadline each.
 *
 * Two kinds. The server starts each JOB in its OWN process group
 * ({@link runGroup}): the deadline's SIGKILL takes the whole group. Inside
 * a job, a reader's child program (the Python CAD child, ffprobe, ffmpeg)
 * is started in the JOB's group ({@link runChild}), never a group of its
 * own: when the job ends or is killed, the server's group kill takes the
 * child and anything the child started with it. A process that left the
 * group on purpose (setsid) is what {@link reapOrphans} is for, and the
 * server runs it before the next job may start.
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
import path from 'node:path';
import { envDynamic } from '@mantle/config';

/**
 * The variable every process of a job carries: the job's environment sets
 * it ({@link jobEnv}) and a reader's child keeps it ({@link childEnv}). Its
 * value is the server's own mark, so {@link reapOrphans} finds what this
 * server's jobs left running, and nothing else on the host.
 */
export const JOB_MARK_VAR = 'MANTLE_PARSER_JOB';

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
  const mark = envDynamic(JOB_MARK_VAR);
  return {
    PATH: envDynamic('PATH') ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpdir,
    TMPDIR: tmpdir,
    LANG: 'C.UTF-8',
    ...(mark ? { [JOB_MARK_VAR]: mark } : {}),
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
 * could leave a module for the next. And the server's mark
 * ({@link JOB_MARK_VAR}).
 */
export function jobEnv(scratch: string, mark: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PARSER_TOKEN;
  return {
    ...env,
    TMPDIR: scratch,
    HOME: scratch,
    XDG_CACHE_HOME: path.join(scratch, '.cache'),
    MPLCONFIGDIR: path.join(scratch, '.mpl'),
    TSX_DISABLE_CACHE: '1',
    [JOB_MARK_VAR]: mark,
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
  /** Told the child's pid once it started (the server keeps a running
   *  job's group out of {@link reapOrphans}). */
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

/** The process ids of this process and its ancestors (Linux /proc). */
async function ancestors(): Promise<Set<number>> {
  const out = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !out.has(pid)) {
    out.add(pid);
    const ppid = (await statOf(pid))?.ppid ?? null;
    if (ppid === null) break;
    pid = ppid;
  }
  return out;
}

/** A process's parent and process group (Linux /proc), or null when gone. */
async function statOf(pid: number): Promise<{ ppid: number; pgid: number } | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid pgrp ...": comm may hold spaces and parens, so
    // read after the LAST ')'.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(f[1]);
    const pgid = Number(f[2]);
    return Number.isInteger(ppid) && Number.isInteger(pgid) ? { ppid, pgid } : null;
  } catch {
    return null;
  }
}

/** Whether the process's environment carries `entry` (`NAME=value`). A
 *  process of another user cannot be read: false. */
async function carries(pid: number, entry: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`);
    return raw.toString('utf8').split('\0').includes(entry);
  } catch {
    return false;
  }
}

/** True inside the parser's container: PID 1 is docker's init (tini). */
export async function inParserContainer(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const init = (await fs.readFile('/proc/1/comm', 'utf8')).trim();
    return init === 'docker-init' || init === 'tini';
  } catch {
    return false;
  }
}

/**
 * Kill every process a job left behind, before the next job may start. A
 * job's reader children run in the job's group and die with it; this is
 * for what left the group on purpose (setsid) and would keep a CPU and
 * memory a later job needs.
 *
 * Left behind: a process carrying this server's mark ({@link JOB_MARK_VAR},
 * every process a job starts inherits it) that is not in the group of a
 * job still running (`keepGroups`). As a backstop, inside the parser's
 * container only, a child of PID 1 (tini) that is not this server or one of
 * its ancestors: a process that cleared its environment still has to be
 * someone's child. Outside the container PID 1's children are the host's
 * own services, never touched. Returns how many it killed.
 */
export async function reapOrphans(opts: {
  mark: string;
  keepGroups: ReadonlySet<number>;
}): Promise<number> {
  if (process.platform !== 'linux') return 0;
  const container = await inParserContainer();
  const keep = await ancestors();
  const entry = `${JOB_MARK_VAR}=${opts.mark}`;
  let killed = 0;
  for (const name of await fs.readdir('/proc').catch(() => [] as string[])) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || keep.has(pid)) continue;
    const st = await statOf(pid);
    if (!st || opts.keepGroups.has(st.pgid)) continue;
    const left = (await carries(pid, entry)) || (container && st.ppid === 1);
    if (!left) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      /* gone already */
    }
  }
  return killed;
}

/**
 * Remove whatever is left in the scratch root (`/tmp` in the container)
 * beside the job root: a job's temp files belong in its own directory
 * (TMPDIR), and anything a program wrote straight to /tmp is gone before
 * the next job runs, so no job reads what an earlier one left. Exact names
 * from one readdir, the job root kept. Returns how many entries it removed.
 */
export async function cleanScratch(root: string, keep: string): Promise<number> {
  let removed = 0;
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const p = path.join(root, name);
    if (p === keep) continue;
    await fs.rm(p, { recursive: true, force: true }).then(
      () => removed++,
      () => {},
    );
  }
  return removed;
}

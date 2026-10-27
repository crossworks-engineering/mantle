/**
 * One child process with a hard deadline: started in its OWN process group,
 * so the deadline's SIGKILL takes the whole group (a job's Python CAD child,
 * ffmpeg under ffprobe), never just the leader. The container runs with
 * `init: true`, so a reparented grandchild is reaped by tini.
 *
 * How it ended is reported, never thrown: the caller maps it to the wire's
 * error codes.
 */
import { spawn } from 'node:child_process';

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

export function runGroup(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    cwd?: string;
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
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
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
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    // The caller gave up (the client went away): the group goes too.
    opts.abort?.addEventListener('abort', killGroup, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_HEAD)
        stdout = (stdout + chunk.toString('utf8')).slice(0, STDOUT_HEAD);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    const done = (ended: Ended) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.abort?.removeEventListener('abort', killGroup);
      // A job that exited may have left a child of its own running.
      killGroup();
      resolve(ended);
    };
    child.on('error', (err) =>
      done({ code: null, signal: null, timedOut, stderr, stdout, spawnError: err.message }),
    );
    child.on('close', (code, signal) =>
      done({ code, signal, timedOut, stderr, stdout, spawnError: null }),
    );
  });
}

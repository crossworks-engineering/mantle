/**
 * A new process of this runtime, on every runtime. Node needs tsx to run a
 * TypeScript file and Bun runs one itself, so a `process.execPath` with Node's
 * arguments fails on Bun.
 *
 * Bun also loads a `.env` file from the working directory into every process
 * that does not refuse it. A child whose environment was cut down on purpose
 * (a parser job, the app SQL runner) would get the secrets back, with no error.
 * So every child of Bun gets `--no-env-file`: its environment is the one the
 * caller gave it.
 *
 * Server side only (node:module): not in the @mantle/std barrel, which browser
 * bundles import.
 */
import { createRequire } from 'node:module';

/** A program and its arguments, as `spawn` takes them. */
export type Command = { command: string; args: string[] };

/** The flags a child of this runtime needs before anything else. */
export function runtimeFlags(): string[] {
  return process.versions.bun ? ['--no-env-file'] : [];
}

/** The flags this process started with, less its env files: `--env-file`
 *  beats `--no-env-file` on Bun, and this process's env reaches a child only
 *  through the `env` its caller gives. */
function ownFlags(): string[] {
  const own: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const flag = process.execArgv[i]!;
    if (flag === '--env-file' || flag === '--env-file-if-exists') i++;
    else if (!/^--env-file(?:-if-exists)?=/.test(flag)) own.push(flag);
  }
  return own;
}

/** This runtime on `script`, with the flags this process has: a file this
 *  process could load itself. */
export function selfCommand(script: string, args: readonly string[] = []): Command {
  const own = ownFlags();
  const flags = own.includes('--no-env-file') ? [] : runtimeFlags();
  return { command: process.execPath, args: [...flags, ...own, script, ...args] };
}

/** This runtime on a TypeScript `script`. `from` is the caller's
 *  `import.meta.url`, for the tsx of its own package. Bun has no need of tsx,
 *  and an image for Bun may not have it, so it is resolved on Node only. */
export function tsCommand(from: string, script: string, args: readonly string[] = []): Command {
  if (process.versions.bun) {
    return { command: process.execPath, args: [...runtimeFlags(), script, ...args] };
  }
  const tsx = createRequire(from).resolve('tsx/cli');
  return { command: process.execPath, args: [tsx, script, ...args] };
}

/** How a process under a memory limit ends when its engine cannot go on: a
 *  crash signal, or an error nothing caught. It is the likely cause and not a
 *  proved one, so what a caller reads should say so. Read it only for a process
 *  that said it started: before that, exit code 1 is a start-up failure. */
export function crashedAtLimit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return (
    code === 1 ||
    (signal !== null && ['SIGABRT', 'SIGBUS', 'SIGILL', 'SIGSEGV', 'SIGTRAP'].includes(signal))
  );
}

/** What a child process sends on IPC once it runs, before any job: its exit
 *  before this is a start-up failure, not a statement that met the limit. */
export const CHILD_READY = 'mantle-child-ready';

/** An exit of a SQL child as the caller should read it: it never started, it
 *  crashed (most likely at its memory limit), it was SIGKILLed by someone else
 *  (most likely the kernel, short of memory), or it ended some other way. */
export function childEnd(
  code: number | null,
  signal: NodeJS.Signals | null,
  started: boolean,
  killedByUs: boolean,
): 'no-start' | 'crashed' | 'killed' | 'exited' {
  if (!started) return 'no-start';
  if (crashedAtLimit(code, signal)) return 'crashed';
  if (signal === 'SIGKILL' && !killedByUs) return 'killed';
  return 'exited';
}

/**
 * A pace for the work a refused statement causes: each one kills its child,
 * and the next statement forks a new one, which blocks the event loop for tens
 * of milliseconds on Linux. `burst` refusals pass at once, then `perSecond`.
 * Each call waits its turn (first come, first served), so a caller that keeps
 * sending refused statements is slowed, and statements that pass never wait.
 */
export function refusalPace(burst: number, perSecond: number): () => Promise<void> {
  // A monotonic clock: a wall clock set back would make a refusal wait for hours.
  let tokens = burst;
  let last = performance.now();
  let queue: Promise<void> = Promise.resolve();
  return () => {
    queue = queue.then(async () => {
      const now = performance.now();
      tokens = Math.min(burst, tokens + (Math.max(0, now - last) / 1000) * perSecond);
      last = now;
      if (tokens < 1) {
        await new Promise((resolve) => setTimeout(resolve, ((1 - tokens) / perSecond) * 1000));
        tokens = 1;
        last = performance.now();
      }
      tokens -= 1;
    });
    return queue;
  };
}

/** The live members of a pool: a child being killed holds no place. */
export function livePlaces(children: Iterable<{ doomed: boolean }>): number {
  let n = 0;
  for (const c of children) if (!c.doomed) n++;
  return n;
}

/** The JIT pool of a process under a memory limit. */
const JIT_POOL_BYTES = 128 * 1024 * 1024;

/**
 * `cmd` under a hard memory limit of `mb` MB, set by the kernel. Bun ignores a worker's `resourceLimits` and a heap flag, and a thread
 * cannot have a limit of its own, so a cap on Bun needs a process.
 *
 * The limit is RLIMIT_DATA. Measured on Bun 1.4.4 on Linux: past it the heap,
 * a Uint8Array and WebAssembly memory each fail (a RangeError, or an abort when
 * the engine cannot go on). RLIMIT_AS would not start: the engine reserves
 * gigabytes it does not use. Bun needs about 300 MB of it to start.
 *
 * The JIT's default memory pool counts against the limit. Below about 2.5 GB
 * the engine cannot reserve it and runs with no JIT, with no error, 30 times
 * slower. So the pool is cut to a size that fits (BUN_JSC_jitMemoryReservationSize).
 *
 * The limit holds one process. Many of them together can still fill a
 * container, so each is the first the kernel kills then, before the server that
 * started it (oom_score_adj). A crash writes no core file (`ulimit -c`), and
 * where the core goes to a program, as it does on Ubuntu, `ulimit` has no effect
 * and coredump_filter keeps that core small: a full one costs seconds, and it
 * holds the data the process read. Those two are best effort.
 *
 * Linux only. macOS refuses to set the limit, and no box runs macOS. On Linux a
 * limit that cannot be set stops the command: it never runs without one.
 */
export function withMemoryLimit(mb: number, cmd: Command): Command {
  if (process.platform !== 'linux') return cmd;
  return {
    command: '/bin/sh',
    args: [
      '-c',
      '{ echo 1000 >/proc/self/oom_score_adj; echo 0 >/proc/self/coredump_filter; } 2>/dev/null; ' +
        'ulimit -c 0 && ulimit -d "$1" && shift && ' +
        `export BUN_JSC_jitMemoryReservationSize=${JIT_POOL_BYTES} && exec "$@"`,
      'sh',
      String(mb * 1024),
      cmd.command,
      ...cmd.args,
    ],
  };
}

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

/** The JIT pool of a process under a memory limit. */
const JIT_POOL_BYTES = 128 * 1024 * 1024;

/**
 * `cmd` under a hard memory limit of `mb` MB, set by the kernel, with no core
 * file. Bun ignores a worker's `resourceLimits` and a heap flag, and a thread
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
 * Linux only. macOS refuses to set the limit, and no box runs macOS. On Linux a
 * limit that cannot be set stops the command: it never runs without one.
 */
export function withMemoryLimit(mb: number, cmd: Command): Command {
  if (process.platform !== 'linux') return cmd;
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'ulimit -c 0 && ulimit -d "$1" && shift && ' +
        `export BUN_JSC_jitMemoryReservationSize=${JIT_POOL_BYTES} && exec "$@"`,
      'sh',
      String(mb * 1024),
      cmd.command,
      ...cmd.args,
    ],
  };
}

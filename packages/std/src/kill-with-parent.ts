/**
 * A child that dies with this process, however this process dies.
 *
 * A child inside a long native call (a SQLite statement) has a blocked event
 * loop, so it never sees its IPC channel close: `process.on('disconnect')`
 * does not run, and it outlives a crashed or restarted server with one core
 * busy. Mac and Linux share no "die with my parent" call (PR_SET_PDEATHSIG is
 * Linux only), so a guard does it: one small `sh` that blocks reading a pipe
 * from this process. The OS closes the pipe when this process ends, by any
 * signal, `read` returns, and the guard SIGKILLs the child.
 *
 * A worker thread in the child that watches process.ppid works too, but it
 * adds 16 to 19 MB to a 45 MB child and polls. The guard adds 2 MB of RSS
 * (170 KB of PSS, nearly all of it shared) and acts within 6 ms of the death
 * (measured 2026-11-01, Mac and Linux).
 *
 * This process starts the guard, not the child, so that this process reaps it.
 * A guard started by the child would outlive a child killed at its time limit,
 * pass to PID 1 and stay a zombie: only the parser container runs an init.
 *
 * Node only (node:child_process): its own entry, '@mantle/std/kill-with-parent',
 * so the package index stays free of node APIs.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** The guard's name in `ps`. */
const GUARD_NAME = 'mantle-child-guard';

/** SIGKILL `child` when this process ends. Call it right after the spawn. A
 *  guard that fails to start costs the protection, never the child. */
export function killWithParent(child: ChildProcess): void {
  if (child.pid === undefined) return;
  let guard: ChildProcess;
  try {
    guard = spawn('/bin/sh', ['-c', 'read _; kill -9 "$1"', GUARD_NAME, String(child.pid)], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Builtins only, so it needs no PATH, and it gets none of the secrets.
      env: {},
    });
  } catch {
    return;
  }
  guard.on('error', () => {});
  // Out of file descriptors, spawn returns a process with no stdin.
  guard.stdin?.on('error', () => {});
  guard.unref();
  // By signal, not by closing the pipe: the guard must not `kill` a pid that
  // is free again.
  child.once('exit', () => guard.kill('SIGKILL'));
}

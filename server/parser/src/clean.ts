/**
 * The check after every job (./main.ts), before the slot is given back: is
 * the container as clean as a fresh one? The container is the boundary
 * between jobs. Nothing here repairs a dirty one: a job that left anything
 * behind makes the server exit, and Docker restarts the container with a
 * fresh tmpfs and a fresh process table (docs/parser.md, "Between jobs").
 *
 * Clean means, inside the parser's container:
 *
 *  - Processes: PID 1 (Docker's init, tini), the server's launcher chain
 *    (pnpm, then this server; `strays`), the processes they keep under them
 *    (tsx's esbuild transformer, pnpm's process-group helper), and processes
 *    entered from outside the container (`docker exec`: the healthcheck, an
 *    operator), whose parent is outside it. Nothing of the job: no member of its
 *    process group, and nothing that left it (setsid, a double fork): such a
 *    process is re-parented to PID 1 when the job dies, and descends from
 *    neither the server nor `docker exec`.
 *  - Files: the image's root filesystem is read-only (compose
 *    `read_only: true`), so the job user can write only to the tmpfs
 *    mounts: /tmp, where the job root (`workdir`) must be the only entry
 *    and empty, and /dev/shm and /dev/mqueue, which must be empty. Nor may
 *    a System V IPC object (shared memory, a semaphore, a message queue)
 *    outlive the job: the container's IPC namespace is its own.
 *
 * Outside the container (a developer's machine, a test) only the job root
 * is checked: the host's processes and its /tmp are not the parser's.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** True inside the parser's container: PID 1 is Docker's init (tini). */
export async function inParserContainer(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const init = (await fs.readFile('/proc/1/comm', 'utf8')).trim();
    return init === 'docker-init' || init === 'tini';
  } catch {
    return false;
  }
}

/** One process, as /proc/<pid>/stat says. */
export type Proc = { pid: number; ppid: number; pgid: number; state: string };

/** Every process this one can see (Linux /proc): the container's own
 *  inside its PID namespace. */
export async function readProcs(): Promise<Proc[]> {
  const out: Proc[] = [];
  for (const name of await fs.readdir('/proc')) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ppid pgrp ...": comm may hold spaces and parens,
      // so read after the LAST ')'.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(f[1]);
      const pgid = Number(f[2]);
      if (Number.isInteger(ppid) && Number.isInteger(pgid)) {
        out.push({ pid, ppid, pgid, state: f[0] ?? '' });
      }
    } catch {
      /* gone between the readdir and the read */
    }
  }
  return out;
}

/**
 * The processes that should not be there after a job (see the module
 * comment), from a process table. `self` is this server; `job` is the job's
 * process group (its leader's pid). A zombie is dead already (its parent
 * reaps it) and is never one.
 */
export function strays(procs: readonly Proc[], self: number, job?: number): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // The launcher: this server's oldest ancestor below PID 1 (pnpm in the
  // image; the server itself when PID 1 started it).
  let launcher = self;
  for (let i = 0; i < 64; i++) {
    const up = byPid.get(launcher)?.ppid;
    if (up === undefined || up <= 1 || !byPid.has(up)) break;
    launcher = up;
  }
  const allowed = (p: Proc): boolean => {
    if (p.pid === 1) return true;
    if (p.state === 'Z') return true;
    if (job !== undefined && p.pgid === job) return false;
    for (let cur: Proc | undefined = p, i = 0; cur && i < 64; i++) {
      if (cur.pid === launcher) return true;
      if (job !== undefined && cur.pid === job) return false;
      // Entered from outside the container (docker exec): its parent is
      // not in this PID namespace.
      if (cur.ppid === 0) return true;
      if (cur.ppid === 1) return false;
      cur = byPid.get(cur.ppid);
    }
    return false;
  };
  return procs.filter((p) => !allowed(p));
}

/** The tmpfs mounts beside /tmp that a job could write to; each must be
 *  empty after a job (when it exists). */
export const EMPTY_MOUNTS = ['/dev/shm', '/dev/mqueue'] as const;

/** The System V IPC tables (Linux /proc): a header line, then one line per
 *  object. */
export const SYSV_IPC_TABLES = ['/proc/sysvipc/shm', '/proc/sysvipc/sem', '/proc/sysvipc/msg'];

/**
 * What a job left in the scratch space, or null when it is clean: the job
 * root (`workdir`) must be there and empty; in the container `scratchRoot`
 * (/tmp) must hold nothing else and {@link EMPTY_MOUNTS} nothing at all.
 */
export async function leftovers(opts: {
  workdir: string;
  scratchRoot: string;
  container: boolean;
  emptyMounts?: readonly string[];
  ipcTables?: readonly string[];
}): Promise<string | null> {
  const inRoot = await fs.readdir(opts.workdir);
  if (inRoot.length > 0) {
    return `the job root ${opts.workdir} still holds ${inRoot.length} entr${inRoot.length === 1 ? 'y' : 'ies'}`;
  }
  if (!opts.container) return null;
  const rootName = path.basename(opts.workdir);
  const extra = (await fs.readdir(opts.scratchRoot)).filter((n) => n !== rootName);
  if (extra.length > 0) {
    return `${opts.scratchRoot} holds ${extra.length} entr${extra.length === 1 ? 'y' : 'ies'} beside the job root`;
  }
  for (const dir of opts.emptyMounts ?? EMPTY_MOUNTS) {
    const names = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    if (names.length > 0) {
      return `${dir} holds ${names.length} entr${names.length === 1 ? 'y' : 'ies'}`;
    }
  }
  for (const table of opts.ipcTables ?? SYSV_IPC_TABLES) {
    const raw = await fs.readFile(table, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const objects = raw
      .split('\n')
      .slice(1)
      .filter((l) => l.trim()).length;
    if (objects > 0) return `${objects} System V IPC object(s) in ${table}`;
  }
  return null;
}

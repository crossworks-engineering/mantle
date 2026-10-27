/**
 * The check after every job (./clean.ts). What is pinned:
 *  - processes: in a container's process table, PID 1, the server's
 *    launcher chain and what the server keeps under it are clean, and so
 *    is a process entered from outside (docker exec: the healthcheck);
 *    anything of the job's group, a descendant of the job, and a process
 *    that left the job (re-parented to PID 1, or a child of one) is not; a
 *    zombie is dead already;
 *  - files: the job root must be empty; in the container the scratch root
 *    may hold the job root alone, the other tmpfs mounts nothing, and no
 *    System V IPC object may be left.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leftovers, readProcs, strays, type Proc } from './clean';

const p = (pid: number, ppid: number, pgid = pid, state = 'S'): Proc => ({
  pid,
  ppid,
  pgid,
  state,
});

/** The parser's container as the image runs it: tini (1), pnpm (7), the
 *  server (20, a node child of pnpm), the server's esbuild (31). */
const BASE: Proc[] = [p(1, 0), p(7, 1), p(20, 7, 7), p(31, 20, 7)];
const SELF = 20;

describe('strays', () => {
  it('a clean container: init, the launcher chain and the server’s own helper', () => {
    expect(strays(BASE, SELF)).toEqual([]);
    expect(strays(BASE, SELF, 40)).toEqual([]);
  });

  it('the server started by PID 1 directly is its own launcher', () => {
    expect(strays([p(1, 0), p(9, 1), p(12, 9, 9)], 9)).toEqual([]);
  });

  it('a process entered from outside the container (docker exec) is not the job’s', () => {
    // The healthcheck's node, and a shell an operator opened with a child.
    const procs = [...BASE, p(50, 0), p(51, 0), p(52, 51, 51)];
    expect(strays(procs, SELF, 40)).toEqual([]);
  });

  it('the job’s group, still there, is a stray', () => {
    const procs = [...BASE, p(40, SELF), p(41, 40, 40)];
    expect(strays(procs, SELF, 40).map((x) => x.pid)).toEqual([40, 41]);
  });

  it('a descendant of the job in a group of its own is a stray', () => {
    const procs = [...BASE, p(40, SELF), p(42, 40, 42)];
    expect(strays(procs, SELF, 40).map((x) => x.pid)).toEqual([40, 42]);
  });

  it('a process that left the job (setsid, a double fork) is re-parented to PID 1: a stray', () => {
    const procs = [...BASE, p(60, 1), p(61, 60, 60)];
    expect(strays(procs, SELF, 40).map((x) => x.pid)).toEqual([60, 61]);
    // Whatever group it took, and with no job named.
    expect(strays([...BASE, p(62, 1, 7)], SELF).map((x) => x.pid)).toEqual([62]);
  });

  it('a zombie is dead already', () => {
    expect(strays([...BASE, p(70, 1, 70, 'Z')], SELF, 40)).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('reads this host’s process table', async () => {
    const procs = await readProcs();
    expect(procs.some((x) => x.pid === process.pid && x.ppid === process.ppid)).toBe(true);
  });
});

describe('leftovers', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function scratch(): { workdir: string; shm: string } {
    root = mkdtempSync(path.join(os.tmpdir(), 'parser-clean-'));
    const workdir = path.join(root, 'tmp', 'mantle-parser');
    const shm = path.join(root, 'shm');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(shm);
    return { workdir, shm };
  }

  it('clean: the job root alone, empty, and the other mounts empty or absent', async () => {
    const { workdir, shm } = scratch();
    const opts = {
      workdir,
      scratchRoot: path.dirname(workdir),
      container: true,
      emptyMounts: [shm, path.join(root, 'no-such-mount')],
      ipcTables: [path.join(root, 'shm-table')],
    };
    writeFileSync(path.join(root, 'shm-table'), '       key      shmid perms\n');
    expect(await leftovers(opts)).toBeNull();
  });

  it('a job root that still holds anything', async () => {
    const { workdir } = scratch();
    mkdirSync(path.join(workdir, 'text-abc'));
    const why = await leftovers({ workdir, scratchRoot: path.dirname(workdir), container: false });
    expect(why).toContain('still holds 1 entry');
  });

  it('in the container: anything beside the job root, or in another mount', async () => {
    const { workdir, shm } = scratch();
    const scratchRoot = path.dirname(workdir);
    writeFileSync(path.join(scratchRoot, 'left.txt'), 'x');
    const table = path.join(root, 'shm-table');
    writeFileSync(table, '       key      shmid perms\n');
    const opts = { workdir, scratchRoot, container: true, emptyMounts: [shm], ipcTables: [table] };
    expect(await leftovers(opts)).toContain('beside the job root');
    rmSync(path.join(scratchRoot, 'left.txt'));
    writeFileSync(path.join(shm, 'seg'), 'x');
    expect(await leftovers(opts)).toContain(`${shm} holds 1 entry`);
    rmSync(path.join(shm, 'seg'));
    expect(await leftovers(opts)).toBeNull();
    writeFileSync(table, '       key      shmid perms\n  1234   5   600\n');
    expect(await leftovers(opts)).toContain('1 System V IPC object(s)');
  });

  it('outside the container only the job root counts', async () => {
    const { workdir } = scratch();
    writeFileSync(path.join(path.dirname(workdir), 'host-file'), 'x');
    expect(
      await leftovers({ workdir, scratchRoot: path.dirname(workdir), container: false }),
    ).toBeNull();
  });

  it('a job root that is gone is a cleanup that failed (throws)', async () => {
    const { workdir } = scratch();
    rmSync(workdir, { recursive: true });
    await expect(
      leftovers({ workdir, scratchRoot: path.dirname(workdir), container: false }),
    ).rejects.toThrow();
  });
});

/**
 * The guard of killWithParent: real processes, because the point of it is what
 * the OS does when a process dies. The SQL runners test the same with a child
 * inside an endless query (app-sql-runner.test.ts).
 */
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { killWithParent } from './kill-with-parent';

const HERE = fileURLToPath(new URL('./kill-with-parent.ts', import.meta.url));

/** Running, not gone and not a zombie waiting for a parent that never reaps. */
function running(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  return cond();
}

/** The guards this process started for `pid`. */
function guardsOf(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', `mantle-child-guard ${pid}$`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

describe('killWithParent', () => {
  it('kills the child when the parent exits, and does not keep the parent alive', async () => {
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { spawn } from 'node:child_process';
        const { killWithParent } = await import(${JSON.stringify(HERE)});
        const child = spawn('sleep', ['60'], { stdio: 'ignore' });
        killWithParent(child);
        child.unref();
        console.log(child.pid);
        `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const pid = await new Promise<number>((resolve) =>
      parent.stdout.once('data', (d) => resolve(Number(String(d)))),
    );
    try {
      const code = await new Promise((resolve) => parent.once('exit', resolve));
      expect(code).toBe(0);
      expect(await until(() => !running(pid))).toBe(true);
    } finally {
      if (running(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('leaves with its child, so a long-lived parent does not collect guards', async () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const pid = child.pid!;
    killWithParent(child);
    expect(await until(() => guardsOf(pid).length === 1)).toBe(true);
    const [guard] = guardsOf(pid) as [number];
    child.kill('SIGKILL');
    expect(await until(() => !running(guard))).toBe(true);
  });

  it('starts no guard for a child that never started', () => {
    const child = spawn('/no/such/program', [], { stdio: 'ignore' });
    child.on('error', () => {});
    expect(() => killWithParent(child)).not.toThrow();
  });
});

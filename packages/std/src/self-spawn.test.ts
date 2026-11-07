import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  childEnd,
  crashedAtLimit,
  livePlaces,
  refusalPace,
  runtimeFlags,
  tsCommand,
  withMemoryLimit,
} from './self-spawn';

const dir = mkdtempSync(join(tmpdir(), 'self-spawn-'));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const run = (c: { command: string; args: string[] }, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(c.command, c.args, { cwd: dir, env, encoding: 'utf8' });

describe('a new process of this runtime', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tsCommand runs a file with its arguments', () => {
    const script = file('self.mjs', 'console.log(process.argv.slice(2).join("+"));');
    const res = run(tsCommand(script, ['a', 'b']));
    expect(res.stdout.trim()).toBe('a+b');
  });

  it('tsCommand runs a TypeScript file', () => {
    const script = file('typed.ts', 'const n: number = 2; console.log(n + process.argv.length);');
    const res = run(tsCommand(script));
    expect(res.status).toBe(0);
    expect(Number(res.stdout.trim())).toBeGreaterThan(2);
  });

  it('a child with a cut environment does not get a .env file back', () => {
    file('.env', 'SELF_SPAWN_SECRET=from-the-file\n');
    const script = file('env.mjs', 'console.log(process.env.SELF_SPAWN_SECRET ?? "none");');
    expect(run(tsCommand(script)).stdout.trim()).toBe('none');
    const inline = 'console.log(process.env.SELF_SPAWN_SECRET ?? "none");';
    const argv = [...runtimeFlags(), '-e', inline];
    expect(run({ command: process.execPath, args: argv }).stdout.trim()).toBe('none');
  });

  it.runIf(process.platform === 'linux')(
    'withMemoryLimit stops a heap, a buffer and WebAssembly memory',
    () => {
      // Each grows past the limit and ends by itself, so a limit that does not
      // hold is a failure here, not a machine out of memory.
      const grow: Record<string, string> = {
        heap: 'const a=[];for(let n=0;n<100;n++){const b=[];for(let i=0;i<200000;i++)b.push({i});a.push(b)}',
        buffer: 'const a=[];for(let n=0;n<40;n++)a.push(new Uint8Array(1<<26).fill(1))',
        wasm: `const m=new WebAssembly.Memory({initial:1,maximum:65536});
               for(let n=0;n<40;n++){m.grow(1024);new Uint8Array(m.buffer).fill(1,m.buffer.byteLength-(1<<26))}`,
      };
      for (const [name, body] of Object.entries(grow)) {
        const res = run(withMemoryLimit(512, tsCommand(file(`${name}.mjs`, body))));
        expect(res.status).not.toBe(0);
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'linux')(
    'a process under a limit is the first to go, and writes a small core',
    () => {
      const show = `const fs=require('node:fs');
        console.log(fs.readFileSync('/proc/self/oom_score_adj','utf8').trim(),
          fs.readFileSync('/proc/self/coredump_filter','utf8').trim())`;
      const res = run(withMemoryLimit(1024, tsCommand(file('show.cjs', show))));
      expect(res.stdout.trim().split(' ').map(Number)).toEqual([1000, 0]);
    },
  );

  it('childEnd: an exit before the ready message is a start-up failure, never the limit', () => {
    expect(childEnd(1, null, false, false)).toBe('no-start');
    expect(childEnd(null, 'SIGABRT', false, false)).toBe('no-start');
    expect(childEnd(1, null, true, false)).toBe('crashed');
    expect(childEnd(null, 'SIGSEGV', true, false)).toBe('crashed');
    // A SIGKILL nobody here sent: the kernel, most likely short of memory.
    expect(childEnd(null, 'SIGKILL', true, false)).toBe('killed');
    expect(childEnd(null, 'SIGKILL', true, true)).toBe('exited');
    expect(childEnd(0, null, true, false)).toBe('exited');
  });

  it('livePlaces: a child being killed holds no place in the pool', () => {
    expect(livePlaces([{ doomed: false }, { doomed: true }, { doomed: false }])).toBe(2);
    expect(livePlaces(new Set([{ doomed: true }]))).toBe(0);
  });

  it('refusalPace: a burst passes at once, then the rate holds, in order', async () => {
    const pace = refusalPace(2, 20);
    const t0 = Date.now();
    const done: number[] = [];
    await Promise.all(Array.from({ length: 5 }, (_, i) => pace().then(() => done.push(i))));
    // Two at once, then three more at 20 a second: about 150 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(130);
    expect(done).toEqual([0, 1, 2, 3, 4]);
    // Quiet for a while: the burst is back.
    await new Promise((r) => setTimeout(r, 120));
    const t1 = Date.now();
    await Promise.all([pace(), pace()]);
    expect(Date.now() - t1).toBeLessThan(40);
  });

  it('crashedAtLimit reads a crash, and not a stop the caller asked for', () => {
    expect(crashedAtLimit(null, 'SIGABRT')).toBe(true);
    expect(crashedAtLimit(null, 'SIGSEGV')).toBe(true);
    expect(crashedAtLimit(1, null)).toBe(true);
    expect(crashedAtLimit(null, 'SIGKILL')).toBe(false);
    expect(crashedAtLimit(null, 'SIGTERM')).toBe(false);
    expect(crashedAtLimit(0, null)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('a limit keeps the JIT on', () => {
    // 150 ms with the JIT, about 4.6 s with none.
    const hot = `const t=performance.now();let x=0;for(let i=0;i<3e8;i++)x=(x+i*3)|0;
                 console.log(Math.round(performance.now()-t),x===0)`;
    const res = run(withMemoryLimit(512, tsCommand(file('hot.mjs', hot))));
    expect(res.status).toBe(0);
    expect(Number(res.stdout.split(' ')[0])).toBeLessThan(2_500);
  });

  it.runIf(process.platform === 'linux')('a limit that cannot be set stops the run', () => {
    const script = file('ran.mjs', 'console.log("ran");');
    const cmd = withMemoryLimit(1, tsCommand(script));
    const huge = { ...cmd, args: cmd.args.map((a) => (a === '1024' ? 'not-a-number' : a)) };
    const res = run(huge);
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain('ran');
  });
});

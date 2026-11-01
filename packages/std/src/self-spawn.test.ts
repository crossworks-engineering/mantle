import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  crashedAtLimit,
  runtimeFlags,
  selfCommand,
  tsCommand,
  withMemoryLimit,
} from './self-spawn';

const isBun = !!process.versions.bun;
/** A package with tsx of its own (@mantle/std has none). */
const WITH_TSX = new URL('../../../server/web/package.json', import.meta.url).href;
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

  it('selfCommand runs a file with its arguments', () => {
    const script = file('self.mjs', 'console.log(process.argv.slice(2).join("+"));');
    const res = run(selfCommand(script, ['a', 'b']));
    expect(res.stdout.trim()).toBe('a+b');
  });

  it('tsCommand runs a TypeScript file on every runtime', () => {
    const script = file('typed.ts', 'const n: number = 2; console.log(n + process.argv.length);');
    const res = run(tsCommand(WITH_TSX, script));
    expect(res.status).toBe(0);
    expect(Number(res.stdout.trim())).toBeGreaterThan(2);
  });

  it('a child with a cut environment does not get a .env file back', () => {
    file('.env', 'SELF_SPAWN_SECRET=from-the-file\n');
    const script = file('env.mjs', 'console.log(process.env.SELF_SPAWN_SECRET ?? "none");');
    expect(run(selfCommand(script)).stdout.trim()).toBe('none');
    expect(run(tsCommand(WITH_TSX, script)).stdout.trim()).toBe('none');
    const inline = 'console.log(process.env.SELF_SPAWN_SECRET ?? "none");';
    const argv = [...runtimeFlags(), '-e', inline];
    expect(run({ command: process.execPath, args: argv }).stdout.trim()).toBe('none');
  });

  it('a child does not inherit an env file from the flags of this process', () => {
    const named = file('named.env', 'SELF_SPAWN_SECRET=from-the-named-file\n');
    const script = file('named.mjs', 'console.log(process.env.SELF_SPAWN_SECRET ?? "none");');
    const before = process.execArgv;
    process.execArgv = ['--smol-flag', `--env-file=${named}`, '--env-file', named];
    try {
      const cmd = selfCommand(script);
      expect(cmd.args).not.toContain(named);
      expect(cmd.args.join(' ')).not.toContain('env-file=');
      expect(cmd.args).toContain('--smol-flag');
      const real = { ...cmd, args: cmd.args.filter((a) => a !== '--smol-flag') };
      expect(run(real).stdout.trim()).toBe('none');
    } finally {
      process.execArgv = before;
    }
  });

  it.runIf(isBun && process.platform === 'linux')(
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
        const res = run(withMemoryLimit(512, selfCommand(file(`${name}.mjs`, body))));
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
      const res = run(withMemoryLimit(1024, selfCommand(file('show.cjs', show))));
      expect(res.stdout.trim().split(' ').map(Number)).toEqual([1000, 0]);
    },
  );

  it('crashedAtLimit reads a crash, and not a stop the caller asked for', () => {
    expect(crashedAtLimit(null, 'SIGABRT')).toBe(true);
    expect(crashedAtLimit(null, 'SIGSEGV')).toBe(true);
    expect(crashedAtLimit(1, null)).toBe(true);
    expect(crashedAtLimit(null, 'SIGKILL')).toBe(false);
    expect(crashedAtLimit(null, 'SIGTERM')).toBe(false);
    expect(crashedAtLimit(0, null)).toBe(false);
  });

  it.runIf(isBun && process.platform === 'linux')('a limit keeps the JIT on', () => {
    // 150 ms with the JIT, about 4.6 s with none.
    const hot = `const t=performance.now();let x=0;for(let i=0;i<3e8;i++)x=(x+i*3)|0;
                 console.log(Math.round(performance.now()-t),x===0)`;
    const res = run(withMemoryLimit(512, selfCommand(file('hot.mjs', hot))));
    expect(res.status).toBe(0);
    expect(Number(res.stdout.split(' ')[0])).toBeLessThan(2_500);
  });

  it.runIf(isBun && process.platform === 'linux')(
    'a limit that cannot be set stops the run',
    () => {
      const script = file('ran.mjs', 'console.log("ran");');
      const cmd = withMemoryLimit(1, selfCommand(script));
      const huge = { ...cmd, args: cmd.args.map((a) => (a === '1024' ? 'not-a-number' : a)) };
      const res = run(huge);
      expect(res.status).not.toBe(0);
      expect(res.stdout).not.toContain('ran');
    },
  );
});

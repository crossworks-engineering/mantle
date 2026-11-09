/**
 * The stdio MCP server exits when its client goes (stdio-exit.ts). Real
 * processes, because the bug is a process that stays alive: the child runs
 * the SDK's stdio transport with a timer that stands in for the database
 * pools, so without exitWithClient it never exits.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('./stdio-exit.ts', import.meta.url));

const CHILD = `
  import { McpServer } from '@modelcontextprotocol/server';
  import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
  const { exitWithClient } = await import(${JSON.stringify(HERE)});
  setInterval(() => {}, 1000); // the pools
  const server = new McpServer({ name: 't', version: '0' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  exitWithClient(server, transport);
  console.error('ready');
`;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
});

type Run = { child: ChildProcessWithoutNullStreams; out: () => string; err: () => string };

function start(): Run {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: dirname(HERE),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += String(c)));
  child.stderr.on('data', (c) => (err += String(c)));
  return { child, out: () => out, err: () => err };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !cond() && Date.now() < end;)
    await new Promise((r) => setTimeout(r, 20));
  return cond();
}

/** The exit code, or 'alive' when the child is still running after `ms`. */
function exited(
  child: ChildProcessWithoutNullStreams,
  ms: number,
): Promise<number | null | 'alive'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('alive');
    }, ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** A child that answered initialize: its transport is connected. */
async function connected(): Promise<Run> {
  const run = start();
  run.child.stdin.write(`${INITIALIZE}\n`);
  const up = await until(() => run.out().includes('"id":1') && run.err().includes('ready'), 15_000);
  if (!up) {
    run.child.kill('SIGKILL');
    throw new Error(`the child did not start: ${run.err()}`);
  }
  return run;
}

describe('exitWithClient', () => {
  it('exits 0 when stdin ends, and keeps its logs off the JSON-RPC stream', async () => {
    const run = await connected();
    run.child.stdin.end();
    expect(await exited(run.child, 5000)).toBe(0);
    expect(run.err()).toContain('stdin closed');
    for (const line of run.out().split('\n').filter(Boolean))
      expect(() => JSON.parse(line)).not.toThrow();
  }, 30_000);

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'exits 0 on %s',
    async (signal) => {
      const run = await connected();
      run.child.kill(signal);
      expect(await exited(run.child, 5000)).toBe(0);
      expect(run.err()).toContain(signal);
    },
    30_000,
  );

  it('is wired into the stdio entry', () => {
    const entry = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
    expect(entry).toMatch(/\nexitWithClient\(server, transport\);\n/);
  });
});

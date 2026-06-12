/**
 * Stdio bridge to the Mantle MCP server (apps/mcp) for the API Console.
 *
 * The console lists and invokes MCP tools against the REAL server — the
 * same process Claude Desktop talks to — so what you see here is exactly
 * what an MCP client gets, with zero catalog drift.
 *
 * Lifecycle: lazy singleton. First request spawns `tsx src/server.ts` in
 * apps/mcp and completes the MCP handshake (~1–2s, it opens its own DB
 * pool); subsequent requests reuse the connection. After 5 idle minutes
 * the child is torn down. Cached on globalThis so Next dev HMR doesn't
 * leak orphan processes.
 *
 * Threat model matches apps/mcp's own: stdio only, child inherits this
 * process's env (DB creds), and every route using the bridge sits behind
 * requireOwner(). Nothing new is exposed on the network.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type Bridge = {
  client: Client;
  close: () => Promise<void>;
};

type BridgeGlobal = {
  bridge: Promise<Bridge> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const g = globalThis as typeof globalThis & { __mantleMcpBridge?: BridgeGlobal };
const state: BridgeGlobal = (g.__mantleMcpBridge ??= { bridge: null, idleTimer: null });

/** Locate apps/mcp from wherever the web server happens to run.
 *  Dev runs with cwd=apps/web; a container may run from the repo root. */
function resolveMcpDir(): string {
  if (process.env.MANTLE_MCP_DIR) return process.env.MANTLE_MCP_DIR;
  const candidates = [
    path.resolve(process.cwd(), '../mcp'),
    path.resolve(process.cwd(), 'apps/mcp'),
    path.resolve(process.cwd(), '../../apps/mcp'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'src/server.ts'))) return dir;
  }
  throw new Error(
    'cannot locate apps/mcp — set MANTLE_MCP_DIR to the directory containing src/server.ts',
  );
}

async function spawnBridge(): Promise<Bridge> {
  const mcpDir = resolveMcpDir();
  const tsxBin = path.join(mcpDir, 'node_modules/.bin/tsx');
  const transport = new StdioClientTransport({
    command: existsSync(tsxBin) ? tsxBin : 'tsx',
    args: ['src/server.ts'],
    cwd: mcpDir,
    // Pass the full env: the MCP server needs DATABASE_URL etc., which the
    // web server already has loaded.
    env: process.env as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'mantle-api-console', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* already dead */
      }
    },
  };
}

function bumpIdleTimer(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    const current = state.bridge;
    state.bridge = null;
    state.idleTimer = null;
    void current?.then((b) => b.close()).catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  state.idleTimer.unref?.();
}

async function getBridge(): Promise<Bridge> {
  if (!state.bridge) {
    state.bridge = spawnBridge().catch((err) => {
      state.bridge = null; // failed boot shouldn't poison future attempts
      throw err;
    });
  }
  bumpIdleTimer();
  return state.bridge;
}

export async function listMcpTools(): Promise<McpToolInfo[]> {
  const bridge = await getBridge();
  const res = await bridge.client.listTools();
  return res.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
  }));
}

export type McpCallResult = {
  isError: boolean;
  /** Concatenated text content; JSON-parsed by the client when possible. */
  text: string;
  durationMs: number;
};

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const bridge = await getBridge();
  const t0 = performance.now();
  const res = await bridge.client.callTool({ name, arguments: args });
  const durationMs = Math.round(performance.now() - t0);
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
    .filter(Boolean)
    .join('\n');
  return { isError: res.isError === true, text, durationMs };
}

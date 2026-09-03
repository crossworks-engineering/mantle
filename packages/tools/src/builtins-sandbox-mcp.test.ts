/**
 * Behavioural tests for the sandbox toolbelt bridge: sandbox_mcp_call, plus
 * its lookup twin sandbox_mcp_tools. builtins-sandbox-write.test.ts covers
 * the lifecycle tools; nothing exercised the MCP pair.
 *
 * sandbox_mcp_call runs a Claude Code tool INSIDE a container, so it has the
 * blast radius of sandbox_exec with a richer surface. What must hold:
 *
 *  - The sandbox is resolved through `getSandboxByRef(ownerId, ref)` and a
 *    miss stops everything: no daemon call, no row touch. That lookup is the
 *    whole ownership boundary; a foreign sandbox resolves to nothing.
 *  - The daemon call is pinned (URL, method, body): the tool name and its
 *    arguments go out verbatim, and the timeout is clamped to [1, 1800] so a
 *    model cannot hold a container forever or hand the daemon a zero.
 *  - A daemon refusal comes back as the tool error and leaves the row alone;
 *    a success touches the row, joins the text parts, carries `isError`
 *    through and truncates at the 64 KiB cap.
 *
 * The daemon is stubbed at `fetch`; the row helpers at @mantle/content.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let selectRows: unknown[] = [];

/**
 * The db here is stubbed so importing builtins-sandbox.ts is safe — NOT as
 * coverage. Neither tool under test reads the database: both resolve the
 * sandbox through `getSandboxByRef(ownerId, ref)` (mocked below, and asserted
 * on directly), and the only db statements in builtins-sandbox.ts belong to
 * sandbox_publish, which builtins-sandbox-write.test.ts owns. So the `where`
 * spies below deliberately assert nothing; there is no clause to assert on.
 * (Flagged as a "blind" mock by the 2026-09-03 audit sweep — it is a false
 * positive, and this note is why.)
 */
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => selectRows),
  };
  const update = { set: vi.fn().mockReturnThis(), where: vi.fn(async () => []) };
  const insert = { values: vi.fn(async () => []) };
  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => select),
      update: vi.fn(() => update),
      insert: vi.fn(() => insert),
    },
  };
});
vi.mock('@mantle/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/config')>();
  return {
    ...actual,
    env: ((name: string) =>
      name === 'SANDBOXD_URL'
        ? 'http://sandboxd.test'
        : name === 'SANDBOXD_TOKEN'
          ? 'tok'
          : actual.env(name as Parameters<typeof actual.env>[0])) as typeof actual.env,
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getSandboxByRef: vi.fn(),
    createSandboxRow: vi.fn(),
    setSandboxStatus: vi.fn(),
    touchSandbox: vi.fn(),
    deleteSandboxRow: vi.fn(),
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    createFolder: vi.fn(),
    ensureFilesRootBranch: vi.fn(),
    folderById: vi.fn(),
    folderByPath: vi.fn(),
    readFileById: vi.fn(),
    upsertFile: vi.fn(),
    diskPathForLtree: vi.fn(),
    filesRoot: vi.fn(),
  };
});
vi.mock('@mantle/api-keys', () => ({ setApiKey: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));

import * as dbmod from '@mantle/db';
import { getSandboxByRef, touchSandbox } from '@mantle/content';
import { SANDBOX_TOOLS } from './builtins-sandbox';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const call = SANDBOX_TOOLS.find((t) => t.slug === 'sandbox_mcp_call')!;
const tools = SANDBOX_TOOLS.find((t) => t.slug === 'sandbox_mcp_tools')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ROW = { id: 'sb1', name: 'scratch', status: 'running' };
const OUTPUT_CAP = 64 * 1024;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** The daemon calls made so far: url, method, bearer, and the JSON body. */
function daemonCalls(): Array<{
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}> {
  return vi.mocked(global.fetch).mock.calls.map(([url, init]) => {
    const i = init as RequestInit;
    const headers = i.headers as Record<string, string>;
    return {
      url: String(url),
      method: String(i.method ?? 'GET'),
      auth: headers.Authorization,
      body: typeof i.body === 'string' ? JSON.parse(i.body) : i.body,
    };
  });
}

/** Point the daemon stub at one response for every call. */
function daemonReplies(data: Record<string, unknown>, ok = true): void {
  global.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 409,
    json: async () => data,
  })) as unknown as typeof fetch;
}

/** A tools/call result with the given content parts. */
const mcpResult = (content: Array<Record<string, unknown>>, isError = false) => ({
  result: { content, isError },
});

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  daemonReplies(mcpResult([{ type: 'text', text: 'hello' }]));
  vi.mocked(getSandboxByRef).mockResolvedValue(ROW as never);
  vi.mocked(touchSandbox).mockResolvedValue(undefined);
});

describe('sandbox_mcp_call', () => {
  it('goes through getSandboxByRef, never the database directly', async () => {
    // Pins the note on the db mock above: the owner boundary for these two
    // tools is the getSandboxByRef(ownerId, ref) argument, asserted below, not
    // a WHERE clause. If a db read ever appears here it needs its own
    // owner-scoping assertion, and this test is what says so.
    await call.handler({ sandbox: 'scratch', tool: 'Read' }, ctx);
    expect(vi.mocked(dbmod.db.select)).not.toHaveBeenCalled();
  });

  it('resolves the sandbox under the caller owner and stops on a miss before the daemon', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    const res = await call.handler({ sandbox: 'nope', tool: 'Read' }, ctx);
    expect(errorOf(res)).toMatch(/sandbox nope not found/);
    expect(errorOf(res)).toMatch(/sandbox_list/);
    expect(getSandboxByRef).toHaveBeenCalledWith('o1', 'nope');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(touchSandbox).not.toHaveBeenCalled();
  });

  it('requires a tool name and makes no call without one', async () => {
    expect(errorOf(await call.handler({ sandbox: 'scratch' }, ctx))).toMatch(/tool is required/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts a tools/call to the sandbox mcp endpoint with the arguments and the default timeout', async () => {
    outputOf(
      await call.handler(
        { sandbox: 'scratch', tool: 'Read', arguments: { file_path: '/files/x.py' } },
        ctx,
      ),
    );
    expect(daemonCalls()).toEqual([
      {
        url: 'http://sandboxd.test/sandboxes/sb1/mcp',
        method: 'POST',
        auth: 'Bearer tok',
        body: {
          method: 'tools/call',
          params: { name: 'Read', arguments: { file_path: '/files/x.py' } },
          timeoutSeconds: 120,
        },
      },
    ]);
  });

  it('clamps the timeout to [1, 1800] and sends empty arguments when none are given', async () => {
    outputOf(await call.handler({ sandbox: 'scratch', tool: 'Bash', timeout_seconds: 5000 }, ctx));
    outputOf(await call.handler({ sandbox: 'scratch', tool: 'Bash', timeout_seconds: 0 }, ctx));
    const bodies = daemonCalls().map((c) => c.body as { timeoutSeconds: number; params: unknown });
    expect(bodies.map((b) => b.timeoutSeconds)).toEqual([1800, 1]);
    expect(bodies[0]!.params).toEqual({ name: 'Bash', arguments: {} });
  });

  it('returns a daemon refusal as the tool error and leaves the row untouched', async () => {
    daemonReplies({ error: 'container is not running' }, false);
    expect(errorOf(await call.handler({ sandbox: 'scratch', tool: 'Read' }, ctx))).toMatch(
      /container is not running/,
    );
    expect(touchSandbox).not.toHaveBeenCalled();
  });

  it('joins the text parts, carries isError through, and touches the row on success', async () => {
    daemonReplies(
      mcpResult(
        [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'zz' },
          { type: 'text', text: 'b' },
        ],
        true,
      ),
    );
    const setOutput = vi.fn();
    const setMeta = vi.fn();
    const res = await call.handler(
      { sandbox: 'scratch', tool: 'Read' },
      { ...ctx, step: { setMeta, setOutput, addTokens: vi.fn(), addCost: vi.fn() } },
    );
    expect(outputOf(res)).toEqual({
      sandbox: 'scratch',
      tool: 'Read',
      isError: true,
      content: 'a\nb',
      truncated: false,
    });
    expect(touchSandbox).toHaveBeenCalledWith('sb1');
    expect(setMeta).toHaveBeenCalledWith({
      sandboxId: 'sb1',
      sandbox: 'scratch',
      mcpTool: 'Read',
      timeoutSeconds: 120,
    });
    expect(setOutput).toHaveBeenCalledWith({ isError: true, bytes: 3 });
  });

  it('truncates content past the 64 KiB cap and says so', async () => {
    daemonReplies(mcpResult([{ type: 'text', text: 'x'.repeat(OUTPUT_CAP + 500) }]));
    const out = outputOf(await call.handler({ sandbox: 'scratch', tool: 'Read' }, ctx));
    expect(out.truncated).toBe(true);
    expect(out.content).toMatch(/\[truncated 500 chars\]$/);
  });
});

describe('sandbox_mcp_tools', () => {
  it('stops on a sandbox miss before the daemon', async () => {
    vi.mocked(getSandboxByRef).mockResolvedValue(null);
    expect(errorOf(await tools.handler({ sandbox: 'nope' }, ctx))).toMatch(
      /sandbox nope not found/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('lists the toolbelt with clipped descriptions, or one tool by name', async () => {
    daemonReplies({
      result: { tools: [{ name: 'Read', description: 'r'.repeat(200), inputSchema: { a: 1 } }] },
    });
    expect(outputOf(await tools.handler({ sandbox: 'scratch' }, ctx))).toEqual({
      tools: [{ name: 'Read', description: 'r'.repeat(160) }],
    });
    expect(daemonCalls()[0]!.body).toEqual({ method: 'tools/list' });
    expect(outputOf(await tools.handler({ sandbox: 'scratch', tool: 'Read' }, ctx))).toMatchObject({
      tool: { name: 'Read', inputSchema: { a: 1 } },
    });
    expect(errorOf(await tools.handler({ sandbox: 'scratch', tool: 'Nope' }, ctx))).toMatch(
      /toolbelt has no tool 'Nope'/,
    );
  });
});

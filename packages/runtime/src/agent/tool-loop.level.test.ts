/**
 * The tool loop runs in the agent's scope (member logins Phase 0b, workspaces
 * W5b2, W8c): for the assistant of a workspace other than Admin, the model
 * call and every tool dispatch run inside a turn scope of that workspace,
 * never as system work, so row security decides what the tools read. The
 * audit removed this wrap and every test stayed green; this pins it. No
 * database: the dispatcher and the model are faked, each records the scope
 * it runs in, the agent's workspace lookups answer a live, non-Admin
 * workspace, and withTurnScope enters the scope alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

/** The scope the code runs in: 'admin' for system work, else the workspace
 *  scope's kind and workspaces. */
function where(): string {
  const s = currentScope();
  if (s.kind === 'system') return 'admin';
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/tools', async () => ({
  // The gate's listing (A5 step 5, pick B): asked in the agent's scope,
  // where dispatch calls (loopToolRows).
  turnCallRefusal: async () => null,
  turnListedTools: vi.fn(async <T>(rows: readonly T[]) => {
    h.levels.push(`list:${where()}`);
    return [...rows];
  }),
  validateToolArgs: (
    await vi.importActual<typeof import('../../../tools/src/validate-args')>(
      '../../../tools/src/validate-args',
    )
  ).validateToolArgs,
  sanitizeToolError: (
    await vi.importActual<typeof import('../../../tools/src/errors')>('../../../tools/src/errors')
  ).sanitizeToolError,
  // The one masking and the turn's gate caller (A5 step 3a), real.
  maskToolDatabaseErrors: (
    await vi.importActual<typeof import('../../../tools/src/tool-error-mask')>(
      '../../../tools/src/tool-error-mask',
    )
  ).maskToolDatabaseErrors,
  turnCaller: (
    await vi.importActual<typeof import('../../../tools/src/gate-callers')>(
      '../../../tools/src/gate-callers',
    )
  ).turnCaller,
  UNTRUSTED_CONTENT_TOOL_SLUGS: new Set<string>(),
  PRIVATE_OUTPUT_TOOL_SLUGS: new Set<string>(),
  getDynamicSchema: () => null,
  dispatchTool: vi.fn(async () => {
    h.levels.push(`dispatch:${where()}`);
    return { ok: true, output: { ok: 1 } };
  }),
  resolveTool: vi.fn(async () => null),
  resolveTools: vi.fn(async () => []),
  getBuiltinRedactFields: vi.fn(() => []),
  redactArgsForLogging: vi.fn(<T>(args: T) => args),
  processToolResultForModel: vi.fn(async ({ serialized }: { serialized: string }) => ({
    payload: serialized,
    spilled: false,
    handle: null,
    bytes: serialized.length,
  })),
  resolveResultHandling: vi.fn(() => ({
    inlineMaxBytes: 1_000_000,
    embedMinBytes: 0,
    spillMaxBytes: 10_000_000,
  })),
  notifyPendingCreated: vi.fn(async () => {}),
}));

vi.mock('@mantle/db', async () => {
  const { asSystem, runInViewerScope } = await import('@mantle/db/viewer');
  // Stand-ins for the tables the agent's workspace lookups read
  // (agent-viewer.ts, on the system pool): a live workspace that is not
  // Admin.
  const workspaces = { id: 'workspaces.id' };
  const workspaceUsers = { workspaceId: 'wu.workspace_id', loginId: 'wu.login_id' };
  const select = () => ({
    from: (table: unknown) => {
      const rows =
        table === workspaces
          ? [{ isAdmin: false, ownerId: 'owner-1', archivedAt: null }]
          : [{ moderator: false }];
      const chain: Record<string, unknown> = { where: () => chain, limit: async () => rows };
      return chain;
    },
  });
  return {
    get systemDb(): unknown {
      return (this as { db: unknown }).db;
    },
    db: { select },
    pendingToolCalls: {},
    asSystem,
    workspaces,
    workspaceUsers,
    // A turn scope without a database: the scope alone.
    withTurnScope: vi.fn((scope: never, fn: () => Promise<unknown>) => runInViewerScope(scope, fn)),
  };
});

import { runToolLoop } from './tool-loop';
import type { ChatDispatcher, ChatOptions, ChatResult } from '@mantle/voice';
import type { Tool } from '@mantle/db';

const TOOL = {
  id: 'tool-1',
  ownerId: 'owner-1',
  slug: 'search_nodes',
  name: 'Search',
  description: 'fixture',
  inputSchema: { type: 'object', properties: {} },
  handler: { kind: 'builtin', slug: 'search_nodes' },
  requiresConfirm: false,
  enabled: true,
} as unknown as Tool;

/** First call asks for one tool, second answers; each records its level. */
function adapter(): ChatDispatcher {
  let n = 0;
  return {
    providerId: 'openrouter',
    adapterName: 'fake-chat',
    chat: vi.fn(async (_opts: ChatOptions): Promise<ChatResult> => {
      h.levels.push(`model:${where()}`);
      n += 1;
      if (n === 1) {
        return {
          text: '',
          model: 'fake',
          toolCalls: [
            { id: 't1', type: 'function', function: { name: 'search_nodes', arguments: '{}' } },
          ],
        };
      }
      return { text: 'done', model: 'fake' };
    }),
  };
}

const run = (extra: Record<string, unknown>) =>
  runToolLoop({
    agentRole: null,
    adapter: adapter(),
    apiKey: 'k',
    model: 'm',
    params: {},
    ownerId: 'owner-1',
    initialMessages: [{ role: 'user', content: 'hi' }],
    tools: [TOOL],
    ...extra,
  });

beforeEach(() => {
  h.levels = [];
});

describe('runToolLoop runs in the agent scope', () => {
  it('the Team workspace’s assistant: the model call and the tool dispatch run in its workspace scope', async () => {
    const res = await run({
      agentId: 'a1',
      agentSlug: 'team-responder',
      agentWorkspaceId: 'ws-team',
    });
    expect(res.reply).toBe('done');
    expect(h.levels).toEqual([
      'list:assistant(ws-team)',
      'model:assistant(ws-team)',
      'dispatch:assistant(ws-team)',
      'model:assistant(ws-team)',
    ]);
    expect(where()).toBe('admin'); // the scope ends with the loop
  });

  it('control: a helper answering no login is system work', async () => {
    await run({ agentId: 'a1', agentSlug: 'saskia' });
    expect(h.levels).toEqual(['list:admin', 'model:admin', 'dispatch:admin', 'model:admin']);
  });
});

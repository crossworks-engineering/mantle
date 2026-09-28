/**
 * The tool loop runs at the agent's level (member logins Phase 0b): for a
 * team-level agent, the model call and every tool dispatch run inside the
 * team viewer scope, so row level security decides what the tools read.
 * The audit removed this wrap and every test stayed green; this pins it.
 * No database: the dispatcher and the model are faked, and each records
 * `currentViewerLevel()` at the moment it runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentViewerLevel } from '@mantle/db/viewer';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

vi.mock('@mantle/tools', async () => ({
  validateToolArgs: (
    await vi.importActual<typeof import('../../../tools/src/validate-args')>(
      '../../../tools/src/validate-args',
    )
  ).validateToolArgs,
  sanitizeToolError: (
    await vi.importActual<typeof import('../../../tools/src/errors')>('../../../tools/src/errors')
  ).sanitizeToolError,
  UNTRUSTED_CONTENT_TOOL_SLUGS: new Set<string>(),
  PRIVATE_OUTPUT_TOOL_SLUGS: new Set<string>(),
  getDynamicSchema: () => null,
  dispatchTool: vi.fn(async () => {
    h.levels.push(`dispatch:${currentViewerLevel()}`);
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

vi.mock('@mantle/db', () => ({
  get systemDb(): unknown {
    return (this as { db: unknown }).db;
  },
  db: {},
  pendingToolCalls: {},
}));

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
      h.levels.push(`model:${currentViewerLevel()}`);
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

describe('runToolLoop runs at the agent level', () => {
  it('a team agent: the model call and the tool dispatch run at team', async () => {
    const res = await run({ agentId: 'a1', agentSlug: 'team-responder', agentLevel: 'team' });
    expect(res.reply).toBe('done');
    expect(h.levels).toEqual(['model:team', 'dispatch:team', 'model:team']);
    expect(currentViewerLevel()).toBe('admin'); // the scope ends with the loop
  });

  it('control: an admin agent runs at admin', async () => {
    await run({ agentId: 'a1', agentSlug: 'saskia', agentLevel: 'admin' });
    expect(h.levels).toEqual(['model:admin', 'dispatch:admin', 'model:admin']);
  });

  it('an agent run that does not say its level is refused', async () => {
    await expect(run({ agentId: 'a1', agentSlug: 'team-responder' })).rejects.toThrow(
      /needs agentLevel/,
    );
    expect(h.levels).toEqual([]);
  });
});

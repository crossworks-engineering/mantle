/**
 * runToolLoop with `params.tool_loading = 'deferred'` (docs/tools-and-skills.md
 * "Deferred tool loading"). Locks down the cache contract (the SAME tools array
 * on every round), that every granted tool stays callable (by name and through
 * use_tool), that tool_search answers from the grant, and that an ungranted
 * name is still refused. Mocks follow tool-loop.test.ts; the deferred module,
 * the validator and the guards are REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatched: Array<{ slug: string; input: Record<string, unknown> }> = [];

vi.mock('@mantle/tools', async () => {
  const deferred = await vi.importActual<typeof import('../../../tools/src/selection/deferred')>(
    '../../../tools/src/selection/deferred',
  );
  return {
    ...deferred,
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
    getDynamicSchema: () => undefined,
    dispatchTool: vi.fn(async (tool: { slug: string }, input: Record<string, unknown>) => {
      dispatched.push({ slug: tool.slug, input });
      return { ok: true, output: { done: tool.slug } };
    }),
    resolveTool: vi.fn(async () => null),
    resolveTools: vi.fn(async () => []),
    getBuiltinRedactFields: vi.fn(() => []),
    redactArgsForLogging: vi.fn(<T>(a: T) => a),
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
    isBuiltinReadOnly: vi.fn(() => false),
  };
});

vi.mock('@mantle/db', () => ({ db: {}, systemDb: {}, pendingToolCalls: {} }));

vi.mock('@mantle/tools/client-sourced', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markCreatedClientSourced: vi.fn(async () => 0),
  taintFromText: vi.fn(async () => {}),
}));

const groupsLoaded: string[] = [];
vi.mock('./skills', () => ({
  loadToolGroupsForCatalog: vi.fn(async (ownerId: string) => {
    groupsLoaded.push(ownerId);
    return [
      { slug: 'email', name: 'Email', description: 'Send + read email', tools: ['email_send'] },
      { slug: 'contacts', name: 'Contacts', description: 'People', tools: ['contact_find'] },
      { slug: 'memory-core', name: 'Memory', description: 'Search', tools: ['search_nodes'] },
    ];
  }),
}));

import { runToolLoop } from './tool-loop';
import type { ChatDispatcher, ChatOptions, ChatResult, ChatToolCall } from '@mantle/voice';
import type { Tool } from '@mantle/db';

function tool(
  slug: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Tool {
  return {
    id: `t-${slug}`,
    ownerId: 'owner-1',
    slug,
    name: slug,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    handler: { kind: 'builtin', slug } as never,
    requiresConfirm: false,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Tool;
}

const TOOLS = [
  tool('search_nodes', 'Search the brain.', { q: { type: 'string' } }, ['q']),
  tool(
    'email_send',
    'Send an email to a contact.',
    { to: { type: 'string' }, body: { type: 'string' } },
    ['to', 'body'],
  ),
  tool('contact_find', 'Find a contact by name.', { name: { type: 'string' } }, ['name']),
];

function adapterWith(script: Array<ChatToolCall[] | string>): {
  adapter: ChatDispatcher;
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  let i = 0;
  return {
    calls,
    adapter: {
      providerId: 'openrouter',
      adapterName: 'fake-chat',
      chat: vi.fn(async (opts: ChatOptions): Promise<ChatResult> => {
        calls.push(structuredClone(opts));
        const s = script[i++];
        if (s === undefined) throw new Error('script exhausted');
        return typeof s === 'string'
          ? { text: s, model: 'm', tokensIn: 1, tokensOut: 1 }
          : { text: '', model: 'm', toolCalls: s, tokensIn: 1, tokensOut: 1 };
      }),
    },
  };
}

const call = (id: string, name: string, args: unknown): ChatToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function run(adapter: ChatDispatcher, tool_loading?: 'full' | 'deferred') {
  return runToolLoop({
    adapter,
    apiKey: 'k',
    model: 'm',
    params: tool_loading ? { tool_loading } : {},
    ownerId: 'owner-1',
    initialMessages: [{ role: 'user', content: 'email Bob that the meeting moved' }],
    tools: TOOLS,
  });
}

const sentNames = (o: ChatOptions) => (o.tools ?? []).map((t) => t.function.name);

beforeEach(() => {
  dispatched.length = 0;
  groupsLoaded.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('runToolLoop with deferred tool loading', () => {
  it('sends core + tool_search + use_tool, the same bytes every round', async () => {
    const { adapter, calls } = adapterWith([
      [call('c1', 'tool_search', { query: 'send an email' })],
      [call('c2', 'email_send', { to: 'bob@example.com', body: 'moved' })],
      'done',
    ]);
    const r = await run(adapter, 'deferred');
    expect(r.reply).toBe('done');
    expect(sentNames(calls[0]!)).toEqual(['search_nodes', 'tool_search', 'use_tool']);
    expect(JSON.stringify(calls[1]!.tools)).toBe(JSON.stringify(calls[0]!.tools));
    expect(JSON.stringify(calls[2]!.tools)).toBe(JSON.stringify(calls[0]!.tools));
    // The catalog names every deferred tool; the core tool is not repeated.
    const searchDef = calls[0]!.tools!.find((t) => t.function.name === 'tool_search')!;
    expect(searchDef.function.description).toContain('email_send');
    expect(searchDef.function.description).toContain('contact_find');
    expect(groupsLoaded).toEqual(['owner-1']);
  });

  it('answers tool_search from the grant, with schemas, without dispatching', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'tool_search', { query: 'send an email' })],
      'ok',
    ]);
    const r = await run(adapter, 'deferred');
    const result = r.messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(String(result!.content)) as {
      tools: { name: string; input_schema: unknown }[];
    };
    expect(payload.tools[0]!.name).toBe('email_send');
    expect(payload.tools[0]!.input_schema).toMatchObject({ required: ['to', 'body'] });
    expect(dispatched).toEqual([]);
    expect(r.toolCalls.map((t) => [t.slug, t.status])).toEqual([['tool_search', 'success']]);
  });

  it('dispatches a deferred tool through use_tool as the real tool', async () => {
    const { adapter } = adapterWith([
      [
        call('c1', 'use_tool', {
          name: 'email_send',
          arguments: { to: 'bob@example.com', body: 'hi' },
        }),
      ],
      'sent',
    ]);
    const r = await run(adapter, 'deferred');
    expect(dispatched).toEqual([
      { slug: 'email_send', input: { to: 'bob@example.com', body: 'hi' } },
    ]);
    expect(r.toolCalls[0]!.slug).toBe('email_send');
    // The tool result pairs with the model's own call id.
    expect(r.messages.find((m) => m.role === 'tool')!.toolCallId).toBe('c1');
  });

  it('validates use_tool arguments against the real schema', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'use_tool', { name: 'email_send', arguments: { to: 'bob@example.com' } })],
      'fixed',
    ]);
    const r = await run(adapter, 'deferred');
    expect(dispatched).toEqual([]);
    expect(r.toolCalls[0]).toMatchObject({ slug: 'email_send', status: 'error' });
  });

  it('still refuses a tool outside the grant, by name or through use_tool', async () => {
    const { adapter } = adapterWith([
      [
        call('c1', 'table_delete', { id: 'x' }),
        call('c2', 'use_tool', { name: 'page_delete', arguments: {} }),
      ],
      'no',
    ]);
    const r = await run(adapter, 'deferred');
    expect(dispatched).toEqual([]);
    expect(r.toolCalls.map((t) => t.error)).toEqual([
      "tool 'table_delete' is not in this agent's allowlist",
      "tool 'page_delete' is not in this agent's allowlist",
    ]);
  });

  it('turns a malformed use_tool into a corrective error', async () => {
    const { adapter } = adapterWith([[call('c1', 'use_tool', { arguments: {} })], 'ok']);
    const r = await run(adapter, 'deferred');
    expect(dispatched).toEqual([]);
    expect(r.toolCalls[0]!.status).toBe('error');
    expect(r.toolCalls[0]!.error).toContain('use_tool needs `name`');
  });

  it('leaves the full list untouched when tool_loading is absent or full', async () => {
    for (const mode of [undefined, 'full'] as const) {
      const { adapter, calls } = adapterWith(['hi']);
      await run(adapter, mode);
      expect(sentNames(calls[0]!)).toEqual(['search_nodes', 'email_send', 'contact_find']);
    }
    expect(groupsLoaded).toEqual([]);
  });
});

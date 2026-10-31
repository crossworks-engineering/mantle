/**
 * runToolLoop with `params.tool_loading = 'map'` (docs/tools-and-skills.md
 * "Map tool loading"). Locks down the cache contract (the SAME tools array and
 * system block on every round), tool_call dispatching as the real tool,
 * tool_help, the aliases, the schema reply to bad arguments, the did-you-mean
 * for a name the loop does not list, and gate parity: a call the gate refuses
 * is refused the same way through tool_call as by its own name. Mocks follow
 * tool-loop.deferred.test.ts; the selection modules, the validator and the
 * guards are REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatched: Array<{ slug: string; input: Record<string, unknown> }> = [];
const gate = {
  refuseCall: new Map<string, string>(),
  unlisted: new Set<string>(),
  patchContactFind: false,
};
const parked: Record<string, unknown>[] = [];

vi.mock('@mantle/tools', async () => {
  // tool_search ranks with each builtin's usageTier (A5 step 6d), read from
  // the policy table: loaded empty here (no usage prior), as the mocked
  // database cannot load the registry. The ranking is the selection's own
  // tests' (deferred.usage.test.ts).
  (
    await vi.importActual<typeof import('../../../tools/src/tool-policy')>(
      '../../../tools/src/tool-policy',
    )
  ).loadPolicyTable([]);
  const deferred = await vi.importActual<typeof import('../../../tools/src/selection/deferred')>(
    '../../../tools/src/selection/deferred',
  );
  const map = await vi.importActual<typeof import('../../../tools/src/selection/map')>(
    '../../../tools/src/selection/map',
  );
  return {
    ...deferred,
    ...map,
    // The gate (A5 step 5; proven against the real gate in
    // tool-loop.listing.test.ts): here it refuses what `gate` says.
    turnCallRefusal: async (t: { slug: string }) => gate.refuseCall.get(t.slug) ?? null,
    turnListedTools: async <T extends { slug: string }>(rows: readonly T[]) =>
      rows.filter((r) => !gate.unlisted.has(r.slug)),
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
    builtinPolicy: () => null,
    policyUntrusted: () => false,
    PRIVATE_OUTPUT_TOOL_SLUGS: new Set<string>(),
    // A schema hook for one tool, as generate_image's per-worker enum: the
    // schema reply must hand back what the model is sent.
    getDynamicSchema: (slug: string) =>
      slug === 'contact_find' && gate.patchContactFind
        ? async (d: { parameters: Record<string, unknown> }) => ({
            parameters: { ...d.parameters, description: 'PATCHED-SCHEMA' },
          })
        : undefined,
    // The one gate's call check runs in dispatchTool: refused here as it
    // would refuse, before anything runs.
    dispatchTool: vi.fn(async (tool: { slug: string }, input: Record<string, unknown>) => {
      const refused = gate.refuseCall.get(tool.slug);
      if (refused) return { ok: false, error: refused };
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
    pendingOriginNow: vi.fn(async () => ({ v: 1, stamped: true })),
    isBuiltinReadOnly: vi.fn(() => false),
  };
});

vi.mock('@mantle/db', () => ({
  db: {},
  systemDb: {},
  pendingToolCalls: {},
  // The R6 shim: no database here, the scope is not under test.
  withViewer: vi.fn(async (_for: unknown, fn: () => Promise<unknown>) => fn()),
  // The approval queue's one park: the row it is handed, recorded.
  parkPendingCall: vi.fn(async (row: Record<string, unknown>) => {
    parked.push(row);
    return `pending-${parked.length}`;
  }),
}));

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
      { slug: 'partsdb-read', name: 'PartsDB read', description: '', tools: ['partsdb_part_list'] },
      { slug: 'mcp-acme', name: 'Acme MCP', description: '', tools: ['mcp_acme_find'] },
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
    externalAccess: null,
    createdBy: null,
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

function run(adapter: ChatDispatcher, tool_loading: 'full' | 'deferred' | 'map' = 'map') {
  return runToolLoop({
    agentRole: null,
    adapter,
    apiKey: 'k',
    model: 'm',
    params: { tool_loading },
    ownerId: 'owner-1',
    initialMessages: [
      { role: 'system', content: 'You are the assistant.' },
      { role: 'user', content: 'email Bob that the meeting moved' },
    ],
    tools: TOOLS,
  });
}

const sentNames = (o: ChatOptions) => (o.tools ?? []).map((t) => t.function.name);

beforeEach(() => {
  dispatched.length = 0;
  groupsLoaded.length = 0;
  gate.refuseCall.clear();
  parked.length = 0;
  gate.unlisted.clear();
  gate.patchContactFind = false;
});
afterEach(() => vi.clearAllMocks());

const errorsOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.messages
    .filter((m) => m.role === 'tool')
    .map((m) => String((JSON.parse(String(m.content)) as { error?: string }).error));

describe('runToolLoop with map tool loading', () => {
  it('sends core + tool_call + tool_help and the map, the same bytes every round', async () => {
    const { adapter, calls } = adapterWith([
      [call('c1', 'tool_help', { names: ['email_send'] })],
      [
        call('c2', 'tool_call', {
          name: 'email_send',
          arguments: { to: 'b@example.com', body: 'x' },
        }),
      ],
      'done',
    ]);
    const r = await run(adapter);
    expect(r.reply).toBe('done');
    expect(sentNames(calls[0]!)).toEqual(['search_nodes', 'tool_call', 'tool_help']);
    expect(JSON.stringify(calls[2]!.tools)).toBe(JSON.stringify(calls[0]!.tools));
    const system = (o: ChatOptions) =>
      JSON.stringify(o.messages.filter((m) => m.role === 'system'));
    expect(system(calls[0]!)).toContain('## Tool map');
    expect(system(calls[0]!)).toContain('- contact_find: Find a contact by name.');
    expect(system(calls[2]!)).toBe(system(calls[0]!));
    expect(groupsLoaded).toEqual(['owner-1']);
  });

  it('dispatches tool_call as the real tool, paired with the model call id', async () => {
    const { adapter } = adapterWith([
      [
        call('c1', 'tool_call', {
          name: 'email_send',
          arguments: { to: 'b@example.com', body: 'hi' },
        }),
      ],
      'sent',
    ]);
    const r = await run(adapter);
    expect(dispatched).toEqual([
      { slug: 'email_send', input: { to: 'b@example.com', body: 'hi' } },
    ]);
    expect(r.toolCalls[0]!.slug).toBe('email_send');
    expect(r.messages.find((m) => m.role === 'tool')!.toolCallId).toBe('c1');
  });

  it('answers tool_help from the grant, with schemas, without dispatching', async () => {
    const { adapter } = adapterWith([[call('c1', 'tool_help', { area: 'email' })], 'ok']);
    const r = await run(adapter);
    const payload = JSON.parse(String(r.messages.find((m) => m.role === 'tool')!.content)) as {
      tools: { name: string; input_schema: unknown }[];
    };
    expect(payload.tools.map((t) => t.name)).toEqual(['email_send']);
    expect(payload.tools[0]!.input_schema).toMatchObject({ required: ['to', 'body'] });
    expect(dispatched).toEqual([]);
    expect(r.toolCalls.map((t) => [t.slug, t.status])).toEqual([['tool_help', 'success']]);
  });

  it('keeps use_tool and tool_search as aliases', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'tool_search', { query: 'send an email' })],
      [call('c2', 'use_tool', { name: 'contact_find', arguments: { name: 'Bob' } })],
      'ok',
    ]);
    const r = await run(adapter);
    const first = JSON.parse(String(r.messages.find((m) => m.role === 'tool')!.content)) as {
      tools: { name: string }[];
    };
    expect(first.tools[0]!.name).toBe('email_send');
    expect(dispatched).toEqual([{ slug: 'contact_find', input: { name: 'Bob' } }]);
  });

  it('hands back the schema once when tool_call gets bad arguments', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'tool_call', { name: 'email_send', arguments: { to: 'b@example.com' } })],
      [call('c2', 'tool_call', { name: 'email_send', arguments: { to: 'b@example.com', cc: 1 } })],
      'ok',
    ]);
    const r = await run(adapter);
    const errors = errorsOf(r);
    expect(errors[0]).toContain('Input schema of email_send');
    expect(errors[0]).toContain('"required":["to","body"]');
    expect(errors[1]).not.toContain('Input schema of email_send');
    expect(dispatched).toEqual([]);
  });

  it('hands back the schema the model is sent, dynamic hooks applied, in both lazy modes', async () => {
    gate.patchContactFind = true;
    for (const mode of ['map', 'deferred'] as const) {
      const { adapter } = adapterWith([
        [call('c1', 'tool_call', { name: 'contact_find', arguments: { nme: 'Bob' } })],
        [call('c2', 'use_tool', { name: 'contact_find', arguments: { nme: 'Bob' } })],
        'ok',
      ]);
      const r = await run(adapter, mode);
      const reply = errorsOf(r).find((e) => e.includes('Input schema of contact_find'));
      expect(reply, mode).toContain('PATCHED-SCHEMA');
    }
  });

  it('refuses a name the loop does not list with the closest listed names', async () => {
    const { adapter } = adapterWith([
      [
        call('c1', 'tool_call', { name: 'email_sends', arguments: {} }),
        call('c2', 'emial_send', {}),
      ],
      'no',
    ]);
    const r = await run(adapter);
    expect(dispatched).toEqual([]);
    for (const [i, name] of ['email_sends', 'emial_send'].entries()) {
      expect(r.toolCalls[i]!.status).toBe('error');
      expect(errorsOf(r)[i]).toMatch(
        new RegExp(
          `^tool '${name}' is not in this agent's allowlist\\. Did you mean: email_send, `,
        ),
      );
    }
  });

  // Each call in its own turn: the same call twice in one response is the
  // duplicate guard's (the unwrapped call counts as the same call).
  async function directAndWrapped(args: Record<string, unknown>) {
    const direct = adapterWith([[call('c1', 'email_send', args)], 'no']);
    const wrapped = adapterWith([
      [call('c1', 'tool_call', { name: 'email_send', arguments: args })],
      'no',
    ]);
    return {
      direct: await run(direct.adapter),
      wrapped: await run(wrapped.adapter),
      wrappedCalls: wrapped.calls,
    };
  }

  it('refuses through tool_call exactly as by name when the gate refuses the call', async () => {
    gate.refuseCall.set('email_send', 'email_send is not allowed in this workspace');
    const { direct, wrapped } = await directAndWrapped({ to: 'b@example.com', body: 'hi' });
    expect(dispatched).toEqual([]);
    expect(direct.toolCalls[0]).toMatchObject({ slug: 'email_send', status: 'error' });
    expect(wrapped.toolCalls[0]).toEqual({
      ...direct.toolCalls[0],
      argsJson: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(errorsOf(wrapped)).toEqual(errorsOf(direct));
    expect(errorsOf(direct)[0]).toContain('email_send is not allowed in this workspace');
  });

  it('refuses through tool_call exactly as by name when the gate does not list the tool', async () => {
    gate.unlisted.add('email_send');
    const { direct, wrapped, wrappedCalls } = await directAndWrapped({
      to: 'b@example.com',
      body: 'hi',
    });
    expect(dispatched).toEqual([]);
    expect(errorsOf(wrapped)).toEqual(errorsOf(direct));
    expect(errorsOf(direct)[0]).toContain("tool 'email_send' is not in this agent's allowlist");
    // An unlisted tool is not offered back, in the map or as a suggestion.
    expect(errorsOf(direct)[0]).not.toContain('Did you mean: email_send');
    expect(JSON.stringify(wrappedCalls[0]!.messages)).not.toContain('email_send');
  });

  it('queues a requires_confirm tool through tool_call as by its own name', async () => {
    const confirmed = TOOLS.map((t) =>
      t.slug === 'email_send' ? ({ ...t, requiresConfirm: true } as Tool) : t,
    );
    const args = { to: 'b@example.com', body: 'hi' };
    const results = [];
    for (const first of [
      call('c1', 'email_send', args),
      call('c1', 'tool_call', { name: 'email_send', arguments: args }),
    ]) {
      const { adapter } = adapterWith([[first], 'queued']);
      results.push(
        await runToolLoop({
          agentRole: null,
          adapter,
          apiKey: 'k',
          model: 'm',
          params: { tool_loading: 'map' },
          ownerId: 'owner-1',
          initialMessages: [{ role: 'user', content: 'email Bob' }],
          tools: confirmed,
        }),
      );
    }
    expect(dispatched).toEqual([]);
    expect(parked.map((r) => [r.toolSlug, r.args])).toEqual([
      ['email_send', args],
      ['email_send', args],
    ]);
    for (const r of results) {
      expect(r.toolCalls[0]).toMatchObject({
        slug: 'email_send',
        status: 'skipped',
        error: 'queued_for_approval',
      });
    }
  });

  it('counts the real tool against the per-tool cap, direct and wrapped alike', async () => {
    const { adapter } = adapterWith([
      // One call per round: a batch that starts under a cap completes.
      [call('c1', 'contact_find', { name: 'A' })],
      [call('c2', 'tool_call', { name: 'contact_find', arguments: { name: 'B' } })],
      [call('c3', 'tool_call', { name: 'contact_find', arguments: { name: 'C' } })],
      'ok',
    ]);
    const r = await runToolLoop({
      agentRole: null,
      adapter,
      apiKey: 'k',
      model: 'm',
      params: { tool_loading: 'map' },
      ownerId: 'owner-1',
      initialMessages: [{ role: 'user', content: 'find them' }],
      tools: TOOLS,
      maxCallsPerToolPerTurn: 2,
    });
    expect(dispatched.map((d) => d.input.name)).toEqual(['A', 'B']);
    expect(r.toolCalls.map((t) => t.slug)).toEqual([
      'contact_find',
      'contact_find',
      'contact_find',
    ]);
    expect(r.toolCalls[2]!.status).toBe('error');
  });

  it('turns a malformed tool_call into a corrective error', async () => {
    const { adapter } = adapterWith([[call('c1', 'tool_call', { arguments: {} })], 'ok']);
    const r = await run(adapter);
    expect(dispatched).toEqual([]);
    expect(r.toolCalls[0]!.error).toContain('tool_call needs `name`');
  });

  it('keeps use_tool in deferred loading as it was: tool_help is just an unknown name', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'use_tool', { name: 'tool_help', arguments: {} })],
      'ok',
    ]);
    const r = await run(adapter, 'deferred');
    expect(r.toolCalls[0]!.error).toBe("tool 'tool_help' is not in this agent's allowlist");
  });

  it('does not take tool_call or tool_help in deferred loading', async () => {
    const { adapter } = adapterWith([
      [call('c1', 'tool_call', { name: 'email_send', arguments: {} }), call('c2', 'tool_help', {})],
      'ok',
    ]);
    const r = await run(adapter, 'deferred');
    expect(r.toolCalls.map((t) => t.error)).toEqual([
      "tool 'tool_call' is not in this agent's allowlist",
      "tool 'tool_help' is not in this agent's allowlist",
    ]);
  });
});

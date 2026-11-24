/**
 * The Control Center's tools (docs/control-center.md). They are CC code
 * (owner decision B, 2026-11-09): the registry imports and registers them
 * on a Control Center only, so off a CC no control_* tool exists and their
 * module is never loaded. Their handlers still refuse off a CC before they
 * read or write anything. An archive is a person's act (person-only-acts.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const removed: string[] = [];
/** Key status: a line with a print, on the CC's own box and a linked one. */
const keysWith = vi.hoisted(() => ({
  line: {
    service: 'openrouter',
    setAt: '2026-11-20T10:00:00.000Z',
    print: 'ab-xxxxxxxxx…WXYZ',
    testable: true,
    test: { ok: true, at: '2026-11-20T10:00:01.000Z' },
  },
  // The caller holds the keys area (the CC's own box shows its lines).
  keysArea: true,
  tested: [] as unknown[],
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/api-keys')>()),
  ownKeyLines: vi.fn(async (_owner: string, who?: unknown) => {
    if (who) keysWith.tested.push(who);
    return keysWith.keysArea
      ? { ok: true, keys: [keysWith.line] }
      : { ok: false, reason: 'keys-area' };
  }),
}));
vi.mock('@mantle/db/control-center', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db/control-center')>();
  const kept = {
    id: 'b1',
    url: 'https://box.example.com',
    label: 'Box one',
    at: '2026-11-20T10:00:00.000Z',
    reason: null,
    hasFacts: true,
    keys: [keysWith.line],
    keysReason: null,
    keyResult: null,
  };
  return {
    ...actual,
    listControlKeys: vi.fn(async () => [kept]),
    askControlKeyTests: vi.fn(async () => [
      { boxId: 'b1', ok: true, reason: null, keys: [keysWith.line] },
    ]),
    keyTestBoxes: vi.fn(async (self: Parameters<typeof actual.selfKeyBox>[0] | null) => [
      ...(self ? [{ ...actual.selfKeyBox(self), tested: self.ok ? 'ok' : self.reason }] : []),
      { ...actual.freshKeyBox(actual.keptKeyBox(kept), [keysWith.line]), tested: 'ok' },
    ]),
    removeControlBox: vi.fn(async (id: string) => {
      removed.push(id);
      return true;
    }),
    listControlBoxes: vi.fn(async () => [
      { id: 'b1', url: 'https://box.example.com', label: 'Box one' },
      { id: 'b2', url: 'https://192.0.2.7', label: null },
    ]),
  };
});
// A fake DNS: the real @mantle/std/host-ips runs above it.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) =>
    host === 'box.example.com'
      ? [
          { address: '2001:db8::1', family: 6 },
          { address: '192.0.2.10', family: 4 },
        ]
      : [],
  ),
}));

const { CONTROL_TOOLS } = await import('./builtins-control');
const { personOnlyRefusal } = await import('./person-only-acts');
const ctx = { ownerId: '00000000-0000-4000-8000-000000000001' } as never;
const tool = (slug: string) => CONTROL_TOOLS.find((t) => t.slug === slug)!;

const SLUGS = [
  'control_agent_model_set',
  'control_ban',
  'control_ban_lift',
  'control_ban_list',
  'control_box_add',
  'control_box_list',
  'control_box_remove',
  'control_broadcast',
  'control_default_model_get',
  'control_default_model_set',
  'control_fleet_matrix',
  'control_fleet_settings_set',
  'control_key_set',
  'control_key_status',
  'control_key_test',
  'control_public_key',
  'control_tool_call',
  'control_tool_list',
];

afterEach(() => vi.unstubAllEnvs());

describe('control_box_remove', () => {
  it('refuses off a Control Center and removes nothing', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
    const r = await tool('control_box_remove').handler(
      { id: '00000000-0000-4000-8000-000000000002' },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not a Control Center') });
    expect(removed).toEqual([]);
  });
});

describe('control_box_list', () => {
  it('gives each box the IPs the Control Center resolves for it, IPv4 first', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const r = await tool('control_box_list').handler({}, ctx);
    expect(r).toEqual({
      ok: true,
      output: {
        boxes: [
          {
            id: 'b1',
            url: 'https://box.example.com',
            label: 'Box one',
            ips: ['192.0.2.10', '2001:db8::1'],
          },
          // An IP host: nothing extra.
          { id: 'b2', url: 'https://192.0.2.7', label: null, ips: [] },
        ],
      },
    });
  });
});

describe('control_key_status and control_key_test', () => {
  afterEach(() => {
    keysWith.keysArea = true;
    keysWith.tested.length = 0;
  });

  it('answer every line without its print, this box first', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    for (const slug of ['control_key_status', 'control_key_test']) {
      const r = await tool(slug).handler({}, ctx);
      expect(r.ok, slug).toBe(true);
      const text = JSON.stringify(r);
      expect(text, slug).not.toContain('…');
      expect(text, slug).not.toContain('"print"');
      const boxes = (r as { output: { boxes: { id: string; keys: object[] }[] } }).output.boxes;
      expect(
        boxes.map((b) => b.id),
        slug,
      ).toEqual(['self', 'b1']);
      expect(boxes[1]!.keys[0], slug).toMatchObject({ service: 'openrouter', state: 'works' });
    }
    // The test ran as the acting caller, over MCP.
    expect(keysWith.tested).toEqual([expect.objectContaining({ via: 'mcp' })]);
  });

  it("this box without the keys area: no lines, keys-area, never a test 'ok'", async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    keysWith.keysArea = false;
    const read = await tool('control_key_status').handler({}, ctx);
    const self = (read as { output: { boxes: Record<string, unknown>[] } }).output.boxes[0]!;
    expect(self).toMatchObject({ id: 'self', keys: null, keysReason: 'keys-area' });
    const test = await tool('control_key_test').handler({ boxIds: ['self'] }, ctx);
    const tested = (test as { output: { boxes: Record<string, unknown>[] } }).output.boxes[0]!;
    expect(tested).toMatchObject({ id: 'self', keys: null, tested: 'keys-area' });
  });
});

describe('every control tool', () => {
  it('refuses off a Control Center', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'off');
    for (const t of CONTROL_TOOLS) {
      const r = await t.handler({}, ctx);
      expect(r.ok, t.slug).toBe(false);
    }
    expect(removed).toEqual([]);
  });
});

describe('the registry', () => {
  afterEach(() => {
    vi.doUnmock('./builtins-control');
    vi.resetModules();
  });

  it('off a Control Center registers no control_* tool and never loads their module', async () => {
    vi.resetModules();
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
    let loaded = false;
    vi.doMock('./builtins-control', () => {
      loaded = true;
      return { CONTROL_TOOLS: [] };
    });
    const reg = await import('./registry');
    expect(reg.controlTools()).toEqual([]);
    expect(reg.listBuiltins().filter((t) => t.slug.startsWith('control_'))).toEqual([]);
    expect(loaded).toBe(false);
  });

  it('on a Control Center registers the eighteen', async () => {
    vi.resetModules();
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const reg = await import('./registry');
    expect(
      reg
        .controlTools()
        .map((t) => t.slug)
        .sort(),
    ).toEqual(SLUGS);
    for (const slug of SLUGS) expect(reg.getBuiltin(slug)?.slug, slug).toBe(slug);
  });

  // The policy sweeps run off a CC, where these tools do not exist, so their
  // policy is pinned here: the settings area for all; every write peerRisky
  // and client-sourced always, naming no item; control_box_remove destructive.
  it('on a Control Center each keeps its policy', async () => {
    vi.resetModules();
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const reg = await import('./registry');
    const WRITES = [
      'control_agent_model_set',
      'control_ban',
      'control_broadcast',
      'control_ban_lift',
      'control_box_add',
      'control_box_remove',
      'control_default_model_set',
      'control_fleet_settings_set',
      'control_key_set',
      'control_key_test',
      'control_tool_call',
      'control_tool_list',
    ];
    for (const slug of SLUGS) {
      const p = reg.getBuiltin(slug)!.policy!;
      expect(p.scope, slug).toEqual({ area: 'settings' });
      expect(p.spends, slug).toBe('none');
      const write = WRITES.includes(slug);
      expect(p.effect, slug).toBe(write ? 'write' : 'read');
      expect(p.peerRisky === true, slug).toBe(write);
      expect(p.destructive === true, slug).toBe(slug === 'control_box_remove');
      expect(p.riskClass === 'delete', slug).toBe(slug === 'control_box_remove');
      if (write) {
        expect(p.matrix, slug).toMatchObject({ none: expect.any(String) });
        expect(p.clientSourced, slug).toMatchObject({ kind: 'always' });
      }
    }
  });

  // The gate-param sweep (mcp-core person-only-acts.test.ts) runs off a CC,
  // so each control tool's input names are pinned here: a new param (a
  // confirm, an approve) fails this until someone reads the person-only rule.
  it('on a Control Center each takes only its known params', async () => {
    vi.resetModules();
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const reg = await import('./registry');
    const params = Object.fromEntries(
      reg
        .controlTools()
        .map((t) => [
          t.slug,
          Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort(),
        ]),
    );
    expect(params).toEqual({
      control_agent_model_set: ['boxIds', 'changes'],
      control_ban: ['archive', 'emails', 'issuer', 'oid', 'preview', 'reason'],
      control_ban_lift: ['id'],
      control_ban_list: ['lifted'],
      control_box_add: ['label', 'url'],
      control_box_list: [],
      control_box_remove: ['id'],
      control_broadcast: ['boxIds', 'send', 'text', 'title'],
      control_default_model_get: [],
      control_default_model_set: ['clear', 'keyId', 'provider'],
      control_fleet_matrix: ['boxId'],
      control_fleet_settings_set: ['boxIds', 'changes'],
      control_key_set: ['boxIds', 'service', 'value'],
      control_key_status: [],
      control_key_test: ['boxIds'],
      control_public_key: [],
      control_tool_call: ['args', 'boxIds', 'callIds', 'name'],
      control_tool_list: ['boxId'],
    });
    // The key never reaches a trace, nor a tool call's args.
    expect(reg.getBuiltin('control_key_set')!.redactInputFields).toEqual(['value']);
    expect(reg.getBuiltin('control_tool_call')!.redactInputFields).toEqual(['args']);
    // control_fleet_settings_set: each change's kinds and fields.
    const item = (
      reg.getBuiltin('control_fleet_settings_set')!.inputSchema as {
        properties: { changes: { items: { properties: Record<string, { enum?: string[] }> } } };
      }
    ).properties.changes.items.properties;
    expect(item.kind!.enum).toEqual(['poolEntry', 'updateNotice', 'workerGroup', 'workerModel']);
    expect(Object.keys(item).sort()).toEqual([
      'enabled',
      'endpoint',
      'kind',
      'members',
      'model',
      'name',
      'on',
      'pool',
      'provider',
      'routes',
      'slug',
      'vendor',
      'worker',
    ]);
  });
});

describe("an archive is a person's act", () => {
  const agent = { caller: { entry: 'mcp' } } as never;
  const person = { caller: { entry: 'owner-web' } } as never;

  it('an agent may ban with archive left out or false, never true', () => {
    expect(personOnlyRefusal('control_ban', { emails: ['a@example.com'] }, agent)).toBeNull();
    expect(personOnlyRefusal('control_ban', { archive: false }, agent)).toBeNull();
    expect(personOnlyRefusal('control_ban', { archive: true }, agent)).toMatch(
      /a person's act.*Fleet screen/,
    );
  });

  it('a person may archive', () => {
    expect(personOnlyRefusal('control_ban', { archive: true }, person)).toBeNull();
  });

  it('the tool takes archive as a boolean, no kind', () => {
    const props = (tool('control_ban').inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.archive).toMatchObject({ type: 'boolean' });
    expect(props.kind).toBeUndefined();
  });
});

describe("a broadcast's send is a person's act", () => {
  const agent = { caller: { entry: 'mcp' } } as never;
  const person = { caller: { entry: 'owner-web' } } as never;

  it('an agent may draft with send left out or false, never true', () => {
    expect(personOnlyRefusal('control_broadcast', { text: 'Hi' }, agent)).toBeNull();
    expect(personOnlyRefusal('control_broadcast', { text: 'Hi', send: false }, agent)).toBeNull();
    expect(personOnlyRefusal('control_broadcast', { text: 'Hi', send: true }, agent)).toMatch(
      /a person's act.*every person in the fleet.*Fleet screen/,
    );
  });

  it('a person may send', () => {
    expect(personOnlyRefusal('control_broadcast', { send: true }, person)).toBeNull();
  });
});

describe('control_broadcast: a draft waits for nothing, a bad box id is refused', () => {
  it('only a send waits in a turn that read a client text', () => {
    const rule = tool('control_broadcast').policy!.clientSourced as {
      kind: string;
      when?: (i: Record<string, unknown>) => boolean;
    };
    expect(rule.kind).toBe('always');
    expect(rule.when?.({ text: 'Hi' })).toBe(false);
    expect(rule.when?.({ text: 'Hi', send: false })).toBe(false);
    expect(rule.when?.({ text: 'Hi', send: true })).toBe(true);
  });

  it('refuses box ids that are not ids, and says where to find them', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
    const r = await tool('control_broadcast').handler(
      { text: 'Hi', boxIds: ['box-a', '00000000-0000-4000-8000-000000000002'] },
      ctx,
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a box id.*control_box_list/),
    });
  });
});

/**
 * The Control Center's tools (docs/control-center.md). They are CC code
 * (owner decision B, 2026-11-09): the registry imports and registers them
 * on a Control Center only, so off a CC no control_* tool exists and their
 * module is never loaded. Their handlers still refuse off a CC before they
 * read or write anything. An archive is a person's act (person-only-acts.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const removed: string[] = [];
vi.mock('@mantle/db/control-center', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db/control-center')>();
  return {
    ...actual,
    removeControlBox: vi.fn(async (id: string) => {
      removed.push(id);
      return true;
    }),
  };
});

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
  'control_fleet_matrix',
  'control_fleet_settings_set',
  'control_key_set',
  'control_public_key',
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

  it('on a Control Center registers the ten', async () => {
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
      'control_ban_lift',
      'control_box_add',
      'control_box_remove',
      'control_fleet_settings_set',
      'control_key_set',
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
      control_fleet_matrix: ['boxId'],
      control_fleet_settings_set: ['boxIds', 'changes'],
      control_key_set: ['boxIds', 'service', 'value'],
      control_public_key: [],
    });
    // The key never reaches a trace.
    expect(reg.getBuiltin('control_key_set')!.redactInputFields).toEqual(['value']);
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

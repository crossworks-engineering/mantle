/**
 * Behavioural tests for the tools that turn an authored capability into a
 * DEPLOYED one: tool_group_ensure, agent_grant_tool_group, api_skill_set.
 *
 * Each of these widens what some agent can do, so each carries a guard that
 * matters more than its happy path:
 *
 *  - `tool_group_ensure` is a hard stop on non-grantable kinds. A shell or
 *    builtin slug bundled here would let a later grant walk an agent past the
 *    authoring boundary (run_terminal is the obvious prize), so it refuses
 *    rather than warns, and it refuses before any insert or update. Unknown
 *    slugs, by contrast, are a warning: the tool may be authored next.
 *  - `agent_grant_tool_group` refuses a self-grant before touching the db, and
 *    parks an agent-initiated grant for operator approval instead of applying
 *    it. Only an operator call (no ctx.agent) writes the agent row. Both
 *    lookups are owner-scoped and a miss on either is a failure.
 *  - `api_skill_set` is the ONE skill-authoring tool. It derives the slug from
 *    the group, refuses a group with no integration binding, and refuses to
 *    overwrite a row under that slug that the integration does not already
 *    point at (that row is the owner's). Those three refusals are what keep an
 *    agent categorically unable to rewrite persona or manifest behaviour.
 *
 * The db chains (select with a per-call queue, update, insert) are stubbed;
 * the crud listing, the integration accessors, the vault and the pending
 * notifier are stubbed. Slug rules, the grantable-kind set, integration
 * parsing and the skill body bounds are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit };
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn((_patch: Record<string, unknown>) => ({ where: updateWhere }));
  const insertReturning = vi.fn(async () => [] as unknown[]);
  const insertValues = vi.fn((_row: Record<string, unknown>) => ({
    returning: insertReturning,
    then: (res: (v: unknown) => void) => Promise.resolve(undefined).then(res),
  }));
  return {
    selectQueue,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: updateSet })),
    updateSet,
    insert: vi.fn(() => ({ values: insertValues })),
    insertValues,
    insertReturning,
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    db: { ...actual.db, select: h.select, update: h.update, insert: h.insert },
  };
});
vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return { ...actual, listApiKeys: vi.fn() };
});
vi.mock('./crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crud')>();
  return { ...actual, listToolsForOwner: vi.fn() };
});
vi.mock('./integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration')>();
  return { ...actual, getGroupIntegration: vi.fn(), setGroupIntegration: vi.fn() };
});
vi.mock('./pending-notify', () => ({
  notifyPendingCreated: vi.fn(),
  notifyPendingChanged: vi.fn(),
}));

import { agents, pendingToolCalls, skills, toolGroups } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { listToolsForOwner } from './crud';
import { getGroupIntegration, setGroupIntegration } from './integration';
import { notifyPendingCreated } from './pending-notify';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ensure = TOOLSMITH_TOOLS.find((t) => t.slug === 'tool_group_ensure')!;
const grant = TOOLSMITH_TOOLS.find((t) => t.slug === 'agent_grant_tool_group')!;
const skillSet = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_skill_set')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
/** The same owner, but the call comes from an agent rather than the operator. */
const agentCtx: ToolHandlerContext = {
  ownerId: 'o1',
  agent: { slug: 'toolsmith', depth: 1, delegateTo: [] },
};

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

function summary(slug: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug,
    description: slug,
    inputSchema: {},
    handler: { kind, ...extra },
    requiresConfirm: false,
    enabled: true,
  };
}

const OWNED = [
  summary('geocode', 'http'),
  summary('note_to_page', 'recipe'),
  summary('run_terminal', 'builtin'),
  summary('deploy', 'shell'),
  summary('gh_issue', 'mcp'),
  summary('petstore_get', 'http', { openapi: { connector: 'c1' } }),
];

const EXISTING_GROUP = {
  id: 'g1',
  ownerId: 'o1',
  slug: 'geo-tools',
  name: 'Geo',
  description: '',
  toolSlugs: ['geocode'],
  integration: null,
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.insertReturning.mockResolvedValue([]);
  vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
  vi.mocked(listApiKeys).mockResolvedValue([] as never);
  vi.mocked(getGroupIntegration).mockResolvedValue(null as never);
  vi.mocked(setGroupIntegration).mockResolvedValue({} as never);
  vi.mocked(notifyPendingCreated).mockResolvedValue(undefined as never);
});

describe('tool_group_ensure', () => {
  it('refuses a bad slug and a non-array tool_slugs before any lookup', async () => {
    expect(errorOf(await ensure.handler({ slug: 'Geo Tools', tool_slugs: [] }, ctx))).toMatch(
      /slug must be lowercase/,
    );
    expect(
      errorOf(await ensure.handler({ slug: 'geo-tools', tool_slugs: 'geocode' }, ctx)),
    ).toMatch(/tool_slugs must be an array/);
    expect(listToolsForOwner).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['a builtin', 'run_terminal'],
    ['a shell tool', 'deploy'],
    ['an mcp connector tool', 'gh_issue'],
    ['an openapi-mirrored http tool', 'petstore_get'],
  ])('HARD-refuses %s, writing nothing', async (_label, slug) => {
    // Warning here instead of refusing would let a later grant escalate an
    // agent past the authoring boundary.
    const res = await ensure.handler(
      { slug: 'geo-tools', name: 'Geo', tool_slugs: ['geocode', slug] },
      ctx,
    );
    expect(errorOf(res)).toMatch(new RegExp(`refused: ${slug}`));
    expect(listToolsForOwner).toHaveBeenCalledWith('o1');
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('treats an UNKNOWN slug as a warning, not a refusal', async () => {
    const res = await ensure.handler(
      { slug: 'geo-tools', name: 'Geo', tool_slugs: ['geocode', 'not_yet'] },
      ctx,
    );
    expect(outputOf(res).warnings).toEqual([expect.stringMatching(/'not_yet' does not exist/)]);
    expect(outputOf(res).tool_slugs).toEqual(['geocode', 'not_yet']);
    expect(h.insert).toHaveBeenCalled();
  });

  it.each(['mcp-github', 'openapi-petstore'])(
    'refuses to create %s in the connector namespace',
    async (slug) => {
      expect(errorOf(await ensure.handler({ slug, name: 'X', tool_slugs: [] }, ctx))).toMatch(
        /reserved connector namespace/,
      );
      expect(h.insert).not.toHaveBeenCalled();
    },
  );

  it('refuses to touch an existing connector group, whose membership the sync owns', async () => {
    h.selectQueue.push([{ ...EXISTING_GROUP, integration: { service: 'gh', mcp: { url: 'x' } } }]);
    expect(
      errorOf(await ensure.handler({ slug: 'geo-tools', tool_slugs: [], mode: 'replace' }, ctx)),
    ).toMatch(/is a connector group/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('requires a name when creating, and inserts the group under the caller', async () => {
    expect(
      errorOf(await ensure.handler({ slug: 'geo-tools', tool_slugs: ['geocode'] }, ctx)),
    ).toMatch(/name is required when creating/);
    expect(h.insert).not.toHaveBeenCalled();

    const res = await ensure.handler(
      {
        slug: 'geo-tools',
        name: ' Geo ',
        description: 'Geocoding',
        tool_slugs: ['geocode', 'geocode', 'note_to_page'],
      },
      ctx,
    );
    expect(h.insert).toHaveBeenCalledWith(toolGroups);
    expect(h.insertValues).toHaveBeenCalledWith({
      ownerId: 'o1',
      slug: 'geo-tools',
      name: 'Geo',
      description: 'Geocoding',
      toolSlugs: ['geocode', 'note_to_page'],
      enabled: true,
    });
    expect(outputOf(res)).toMatchObject({
      slug: 'geo-tools',
      created: true,
      tool_slugs: ['geocode', 'note_to_page'],
      warnings: [],
    });
    expect(outputOf(res)).not.toHaveProperty('integration');
  });

  it("merges into an existing group's list by default", async () => {
    h.selectQueue.push([EXISTING_GROUP]);
    const res = await ensure.handler({ slug: 'geo-tools', tool_slugs: ['note_to_page'] }, ctx);
    expect(h.update).toHaveBeenCalledWith(toolGroups);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ toolSlugs: ['geocode', 'note_to_page'] }),
    );
    // A plain bundle ensure must not write an integration key at all.
    expect(h.updateSet.mock.calls[0]![0]).not.toHaveProperty('integration');
    expect(outputOf(res)).toMatchObject({
      created: false,
      tool_slugs: ['geocode', 'note_to_page'],
    });
  });

  it("replaces an existing group's list on mode 'replace'", async () => {
    h.selectQueue.push([EXISTING_GROUP]);
    await ensure.handler({ slug: 'geo-tools', tool_slugs: ['note_to_page'], mode: 'replace' }, ctx);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ toolSlugs: ['note_to_page'] }),
    );
  });

  it('binds an integration, parsing the fields and warning on a missing vault key', async () => {
    const res = await ensure.handler(
      {
        slug: 'weather-tools',
        name: 'Weather',
        tool_slugs: [],
        service: 'openweathermap',
        base_url: 'https://api.openweathermap.org/data/2.5',
        secret_ref: '{{secret:openweathermap/default}}',
        auth_template: { query: { appid: '{{secret:openweathermap/default}}' } },
      },
      ctx,
    );
    const integration = {
      service: 'openweathermap',
      baseUrl: 'https://api.openweathermap.org/data/2.5',
      // The {{secret:...}} wrapper a model copies from api_key_refs is
      // stripped to the bare pointer.
      secretRef: 'openweathermap/default',
      authTemplate: { query: { appid: '{{secret:openweathermap/default}}' } },
    };
    expect(h.insertValues).toHaveBeenCalledWith(expect.objectContaining({ integration }));
    expect(outputOf(res).integration).toMatchObject({
      service: 'openweathermap',
      secret_ref: 'openweathermap/default',
      has_stored_docs: false,
    });
    expect(outputOf(res).warnings).toEqual([
      expect.stringMatching(/secret_ref 'openweathermap\/default' has no matching vault entry/),
    ]);
    expect(outputOf(res).next).toMatch(/api_docs_set/);
  });

  it('refuses an integration whose base_url is not http(s), writing nothing', async () => {
    const res = await ensure.handler(
      { slug: 'weather-tools', name: 'W', tool_slugs: [], service: 'owm', base_url: 'api.owm.org' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/base_url .* must start with http/);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('merges a re-declared binding onto the stored one so the docs pointer survives', async () => {
    // The stored binding is re-parsed with the new field on top, so it has to
    // be a valid one: the docs pointer is a file node id (UUID).
    const DOCS = '22222222-3333-4444-8555-666666666666';
    h.selectQueue.push([{ ...EXISTING_GROUP, integration: { service: 'owm', docsNodeId: DOCS } }]);
    vi.mocked(listApiKeys).mockResolvedValue([{ service: 'owm', label: 'default' }] as never);
    const res = await ensure.handler(
      { slug: 'geo-tools', tool_slugs: [], secret_ref: 'owm/default' },
      ctx,
    );
    expect(outputOf(res).integration).toMatchObject({
      service: 'owm',
      secret_ref: 'owm/default',
      has_stored_docs: true,
    });
    // The vault has the key, so the only warning is that nothing says WHERE
    // the credential goes: a secret_ref without auth_template is inert.
    expect(outputOf(res).warnings).toEqual([expect.stringMatching(/auth_template is empty/)]);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: { service: 'owm', secretRef: 'owm/default', docsNodeId: DOCS },
      }),
    );
  });
});

describe('agent_grant_tool_group', () => {
  const AGENT = { id: 'a1', groups: ['core'] };
  const GROUP = { id: 'g1', toolSlugs: ['geocode', 'note_to_page'] };

  it('refuses a self-grant BEFORE any lookup', async () => {
    // An injected agent must not be able to widen its own capabilities.
    const res = await grant.handler({ agent_slug: 'toolsmith', group_slug: 'geo-tools' }, agentCtx);
    expect(errorOf(res)).toMatch(/cannot grant a tool group to itself/);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('reports an unknown agent without looking the group up or writing', async () => {
    h.selectQueue.push([]);
    expect(
      errorOf(await grant.handler({ agent_slug: 'ghost', group_slug: 'geo-tools' }, ctx)),
    ).toMatch(/agent 'ghost' not found/);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('reports an unknown group with the tool that creates it', async () => {
    h.selectQueue.push([AGENT], []);
    expect(
      errorOf(await grant.handler({ agent_slug: 'responder', group_slug: 'nope' }, ctx)),
    ).toMatch(/tool group 'nope' not found — create it with tool_group_ensure/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('re-checks kinds at grant time and refuses a group holding a shell or builtin', async () => {
    // A slug bundled while unknown may since have resolved to run_terminal.
    h.selectQueue.push([AGENT], [{ id: 'g1', toolSlugs: ['geocode', 'run_terminal', 'deploy'] }]);
    const res = await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, ctx);
    expect(errorOf(res)).toMatch(/non-grantable tools \(run_terminal, deploy\)/);
    expect(listToolsForOwner).toHaveBeenCalledWith('o1');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('allows mcp connector tools in a granted group (grantable, just not bundle-able)', async () => {
    h.selectQueue.push([AGENT], [{ id: 'g1', toolSlugs: ['gh_issue'] }]);
    const res = await grant.handler({ agent_slug: 'responder', group_slug: 'mcp-github' }, ctx);
    expect(outputOf(res)).toMatchObject({ granted: true });
  });

  it('reports an existing grant as already_granted without writing', async () => {
    h.selectQueue.push([{ id: 'a1', groups: ['core', 'geo-tools'] }], [GROUP]);
    const res = await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, ctx);
    expect(outputOf(res)).toEqual({
      agent_slug: 'responder',
      group_slug: 'geo-tools',
      already_granted: true,
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('as the OPERATOR, appends the group to the agent row and reports the grant', async () => {
    h.selectQueue.push([AGENT], [GROUP]);
    const res = await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, ctx);
    expect(h.update).toHaveBeenCalledWith(agents);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ toolGroupSlugs: ['core', 'geo-tools'] }),
    );
    expect(h.insert).not.toHaveBeenCalled();
    expect(notifyPendingCreated).not.toHaveBeenCalled();
    expect(outputOf(res)).toEqual({
      agent_slug: 'responder',
      group_slug: 'geo-tools',
      granted: true,
    });
  });

  it('as an AGENT, parks the grant for operator approval instead of applying it', async () => {
    h.selectQueue.push([AGENT], [GROUP], [{ id: 'req-1' }]);
    h.insertReturning.mockResolvedValue([{ id: 'p1' }]);
    const res = await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, agentCtx);

    // Nothing widened: the agent row is untouched.
    expect(h.update).not.toHaveBeenCalled();
    // The pending row carries the owner, the REQUESTING agent, and the args
    // that will re-run (with no agent context) once approved.
    expect(h.insert).toHaveBeenCalledWith(pendingToolCalls);
    expect(h.insertValues).toHaveBeenCalledWith({
      ownerId: 'o1',
      agentId: 'req-1',
      toolSlug: 'agent_grant_tool_group',
      args: { agent_slug: 'responder', group_slug: 'geo-tools' },
    });
    expect(notifyPendingCreated).toHaveBeenCalledWith({
      ownerId: 'o1',
      pendingId: 'p1',
      toolSlug: 'agent_grant_tool_group',
      args: { agent_slug: 'responder', group_slug: 'geo-tools' },
      via: 'agent toolsmith',
    });
    expect(outputOf(res)).toMatchObject({ status: 'queued_for_approval', pending_id: 'p1' });
    expect(String(outputOf(res).message)).toMatch(/Do not retry/);
  });

  it('as an AGENT, still validates first so an unknown agent is never queued', async () => {
    h.selectQueue.push([]);
    expect(
      errorOf(await grant.handler({ agent_slug: 'ghost', group_slug: 'geo-tools' }, agentCtx)),
    ).toMatch(/not found/);
    expect(h.insert).not.toHaveBeenCalled();
    expect(notifyPendingCreated).not.toHaveBeenCalled();
  });
});

describe('api_skill_set', () => {
  const BODY =
    'Use current_weather for "what is it like now" and forecast_daily for anything about tomorrow or later. ' +
    'Temperatures come back in Kelvin unless units=metric is passed; always pass it. City lookups want "City,CC".';
  const BOUND = {
    id: 'g1',
    slug: 'weather-tools',
    name: 'Weather',
    toolSlugs: ['current_weather'],
    integration: { service: 'openweathermap', docsNodeId: 'n1' },
  };

  it('refuses a bad slug and an unknown group before any write', async () => {
    expect(errorOf(await skillSet.handler({ group_slug: 'Bad', body: BODY }, ctx))).toMatch(
      /group_slug must be lowercase/,
    );
    expect(errorOf(await skillSet.handler({ group_slug: 'nope', body: BODY }, ctx))).toMatch(
      /tool group 'nope' not found/,
    );
    expect(getGroupIntegration).toHaveBeenCalledWith('o1', 'nope');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('refuses a group with NO integration binding: this tool writes API skills only', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({ ...BOUND, integration: null } as never);
    const res = await skillSet.handler({ group_slug: 'weather-tools', body: BODY }, ctx);
    expect(errorOf(res)).toMatch(/is not an integration/);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('refuses a body too short to be know-how, or too long to ride in every prompt', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(BOUND as never);
    expect(
      errorOf(await skillSet.handler({ group_slug: 'weather-tools', body: 'use it' }, ctx)),
    ).toMatch(/too short/);
    expect(
      errorOf(await skillSet.handler({ group_slug: 'weather-tools', body: 'x'.repeat(6001) }, ctx)),
    ).toMatch(/6001 characters/);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a skill under the derived slug that this integration does not own', async () => {
    // That row is the operator's (or the manifest's). Overwriting it is the
    // exact escalation this tool exists to prevent.
    vi.mocked(getGroupIntegration).mockResolvedValue(BOUND as never);
    h.selectQueue.push([{ id: 's-owner' }]);
    const res = await skillSet.handler({ group_slug: 'weather-tools', body: BODY }, ctx);
    expect(errorOf(res)).toMatch(/'api-weather-tools' already exists but isn't linked/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(setGroupIntegration).not.toHaveBeenCalled();
  });

  it('creates the skill under the DERIVED slug and links it to the group', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(BOUND as never);
    const res = await skillSet.handler(
      { group_slug: 'weather-tools', body: `  ${BODY}  `, name: ' Weather API usage ' },
      ctx,
    );
    expect(h.insert).toHaveBeenCalledWith(skills);
    expect(h.insertValues).toHaveBeenCalledWith({
      ownerId: 'o1',
      slug: 'api-weather-tools',
      name: 'Weather API usage',
      description: expect.stringMatching(/openweathermap integration/),
      instructions: BODY,
      enabled: true,
    });
    expect(setGroupIntegration).toHaveBeenCalledWith('o1', 'weather-tools', {
      skillSlug: 'api-weather-tools',
    });
    expect(outputOf(res)).toMatchObject({
      group_slug: 'weather-tools',
      skill_slug: 'api-weather-tools',
      created: true,
      warnings: [],
    });
  });

  it('defaults the name to the group name plus "usage"', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(BOUND as never);
    await skillSet.handler({ group_slug: 'weather-tools', body: BODY }, ctx);
    expect(h.insertValues).toHaveBeenCalledWith(expect.objectContaining({ name: 'Weather usage' }));
  });

  it('revises in place when the integration already owns the skill row', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({
      ...BOUND,
      integration: { ...BOUND.integration, skillSlug: 'api-weather-tools' },
    } as never);
    h.selectQueue.push([{ id: 's1' }]);
    const res = await skillSet.handler({ group_slug: 'weather-tools', body: BODY }, ctx);
    expect(h.update).toHaveBeenCalledWith(skills);
    expect(h.updateSet).toHaveBeenCalledWith(expect.objectContaining({ instructions: BODY }));
    expect(h.insert).not.toHaveBeenCalled();
    expect(outputOf(res).created).toBe(false);
  });

  it('warns when the group has no tools, no stored docs, or the body runs long', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({
      ...BOUND,
      toolSlugs: [],
      integration: { service: 'openweathermap' },
    } as never);
    const long = Array.from({ length: 330 }, (_, i) => `w${i}`).join(' ');
    const res = await skillSet.handler({ group_slug: 'weather-tools', body: long }, ctx);
    expect(outputOf(res).words).toBe(330);
    expect(outputOf(res).warnings).toEqual([
      expect.stringMatching(/330 words/),
      expect.stringMatching(/has no tools yet/),
      expect.stringMatching(/no API documentation is stored/),
    ]);
    // Warnings do not block the write.
    expect(h.insert).toHaveBeenCalled();
  });
});

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
  /** Every where clause handed to a select, in call order. Owner scoping is
   *  asserted against these, not against `where` merely having been called. */
  const selectWheres: unknown[] = [];
  const updateWheres: unknown[] = [];
  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      selectWheres.push(clause);
      return this;
    }),
    limit,
  };
  const updateWhere = vi.fn(async (clause: unknown) => {
    updateWheres.push(clause);
    return undefined;
  });
  const updateSet = vi.fn((_patch: Record<string, unknown>) => ({ where: updateWhere }));
  const insertReturning = vi.fn(async () => [] as unknown[]);
  const insertValues = vi.fn((_row: Record<string, unknown>) => ({
    returning: insertReturning,
    then: (res: (v: unknown) => void) => Promise.resolve(undefined).then(res),
  }));
  return {
    selectQueue,
    selectWheres,
    updateWheres,
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
import { paramsOf } from './test-support';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ensure = TOOLSMITH_TOOLS.find((t) => t.slug === 'tool_group_ensure')!;
const grant = TOOLSMITH_TOOLS.find((t) => t.slug === 'agent_grant_tool_group')!;
const skillSet = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_skill_set')!;
const setEffort = TOOLSMITH_TOOLS.find((t) => t.slug === 'agent_set_thinking_effort')!;

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
  h.selectWheres.length = 0;
  h.updateWheres.length = 0;
  h.insertReturning.mockResolvedValue([]);
  vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
  vi.mocked(listApiKeys).mockResolvedValue([] as never);
  vi.mocked(getGroupIntegration).mockResolvedValue(null as never);
  vi.mocked(setGroupIntegration).mockResolvedValue({} as never);
  vi.mocked(notifyPendingCreated).mockResolvedValue(undefined as never);
});

describe('tool_group_ensure', () => {
  it('scopes the group lookup to the caller, so a slug cannot reach another owner', async () => {
    // Drop `eq(toolGroups.ownerId, ...)` and this ensure would merge into — or
    // with mode:'replace', empty — a group belonging to somebody else that
    // happens to share the slug. The write itself keys off `existing.id`, so
    // this select IS the whole boundary.
    h.selectQueue.push([EXISTING_GROUP]);
    await ensure.handler({ slug: 'geo-tools', tool_slugs: ['note_to_page'] }, ctx);
    expect(paramsOf(h.selectWheres[0])).toEqual(expect.arrayContaining(['o1', 'geo-tools']));
  });

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

  it('a re-declared base_url, secret_ref or auth_template replaces the stored one', async () => {
    h.selectQueue.push([
      {
        ...EXISTING_GROUP,
        integration: {
          service: 'owm',
          baseUrl: 'https://old.example.com',
          secretRef: 'owm/old',
          authTemplate: { query: { appid: '{{secret:owm/old}}' } },
        },
      },
    ]);
    vi.mocked(listApiKeys).mockResolvedValue([{ service: 'owm', label: 'new' }] as never);
    await ensure.handler(
      {
        slug: 'geo-tools',
        tool_slugs: [],
        base_url: 'https://new.example.com',
        secret_ref: 'owm/new',
        auth_template: { query: { appid: '{{secret:owm/new}}' } },
      },
      ctx,
    );
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: {
          service: 'owm',
          baseUrl: 'https://new.example.com',
          secretRef: 'owm/new',
          authTemplate: { query: { appid: '{{secret:owm/new}}' } },
        },
      }),
    );
  });

  it('binds oauth2 client credentials and defaults the bearer placement', async () => {
    vi.mocked(listApiKeys).mockResolvedValue([{ service: 'acme', label: 'client-id' }] as never);
    const res = await ensure.handler(
      {
        slug: 'acme-tools',
        name: 'Acme',
        tool_slugs: [],
        service: 'acme',
        base_url: 'https://api.example.com',
        oauth2: {
          token_url: 'https://auth.example.com/oauth/token',
          client_id_ref: 'acme/client-id',
          client_secret_ref: '{{secret:acme/client-secret}}',
          scope: 'read',
        },
      },
      ctx,
    );
    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: {
          service: 'acme',
          baseUrl: 'https://api.example.com',
          authTemplate: { headers: { Authorization: 'Bearer {{oauth:acme-tools}}' } },
          oauth2: {
            grant: 'client_credentials',
            tokenUrl: 'https://auth.example.com/oauth/token',
            clientIdRef: 'acme/client-id',
            clientSecretRef: 'acme/client-secret',
            scope: 'read',
          },
        },
      }),
    );
    expect(outputOf(res).integration).toMatchObject({
      oauth2: {
        client_id_ref: 'acme/client-id',
        client_secret_ref: 'acme/client-secret',
        client_auth: 'basic',
      },
    });
    // Only the secret is missing from the vault.
    expect(outputOf(res).warnings).toEqual([
      expect.stringMatching(
        /oauth2\.client_secret_ref 'acme\/client-secret' has no matching vault entry/,
      ),
    ]);
  });

  it('refuses oauth2 without a base_url, writing nothing', async () => {
    const res = await ensure.handler(
      {
        slug: 'acme-tools',
        name: 'Acme',
        tool_slugs: [],
        service: 'acme',
        oauth2: {
          token_url: 'https://auth.example.com/oauth/token',
          client_id_ref: 'acme/client-id',
          client_secret_ref: 'acme/client-secret',
        },
      },
      ctx,
    );
    expect(errorOf(res)).toMatch(/oauth2 needs integration\.base_url/);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('oauth2: null removes the OAuth2 config', async () => {
    h.selectQueue.push([
      {
        ...EXISTING_GROUP,
        integration: {
          service: 'acme',
          baseUrl: 'https://api.example.com',
          authTemplate: { headers: { 'X-Key': '{{secret:acme/key}}' } },
          oauth2: {
            grant: 'client_credentials',
            tokenUrl: 'https://auth.example.com/oauth/token',
            clientIdRef: 'acme/client-id',
            clientSecretRef: 'acme/client-secret',
          },
        },
      },
    ]);
    await ensure.handler({ slug: 'geo-tools', tool_slugs: [], oauth2: null }, ctx);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: {
          service: 'acme',
          baseUrl: 'https://api.example.com',
          authTemplate: { headers: { 'X-Key': '{{secret:acme/key}}' } },
        },
      }),
    );
  });
});

describe('tool_group_ensure on a group below admin (client logins C5 audit, L3)', () => {
  // client-read as the manifest ships it: the client agent's whole surface.
  const CLIENT_READ = {
    ...EXISTING_GROUP,
    slug: 'client-read',
    audience: 'client',
    toolSlugs: ['client_shared_list', 'client_shared_open'],
  };
  const owner: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } };

  it('an agent adding a recipe to client-read waits in Pending; nothing is written', async () => {
    h.selectQueue.push([CLIENT_READ], [{ id: 'agent-toolsmith' }]);
    h.insertReturning.mockResolvedValueOnce([{ id: 'p1' }]);
    const input = { slug: 'client-read', tool_slugs: ['note_to_page'] };
    const res = await ensure.handler(input, agentCtx);
    expect(outputOf(res)).toMatchObject({ status: 'queued_for_approval', pending_id: 'p1' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledWith(pendingToolCalls);
    expect(h.insertValues).toHaveBeenCalledWith({
      ownerId: 'o1',
      agentId: 'agent-toolsmith',
      toolSlug: 'tool_group_ensure',
      args: input,
    });
    expect(notifyPendingCreated).toHaveBeenCalledWith(
      expect.objectContaining({ pendingId: 'p1', toolSlug: 'tool_group_ensure' }),
    );
  });

  it("an agent's replace of a team group waits too", async () => {
    h.selectQueue.push([{ ...CLIENT_READ, audience: 'team' }], [{ id: 'agent-toolsmith' }]);
    const res = await ensure.handler(
      { slug: 'client-read', tool_slugs: ['client_shared_list'], mode: 'replace' },
      agentCtx,
    );
    expect(outputOf(res)).toMatchObject({ status: 'queued_for_approval' });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('the owner (the approved pending call, MCP) changes it directly', async () => {
    h.selectQueue.push([CLIENT_READ]);
    const res = await ensure.handler(
      { slug: 'client-read', tool_slugs: ['note_to_page'] },
      { ownerId: 'o1', surface: { kind: 'owner', via: 'pending' } },
    );
    expect(outputOf(res)).toMatchObject({ created: false });
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSlugs: ['client_shared_list', 'client_shared_open', 'note_to_page'],
      }),
    );
    h.selectQueue.push([CLIENT_READ]);
    await ensure.handler({ slug: 'client-read', tool_slugs: ['note_to_page'] }, owner);
    expect(h.update).toHaveBeenCalledTimes(2);
  });

  it('a caller that is neither an agent nor the owner is refused', async () => {
    h.selectQueue.push([CLIENT_READ]);
    const res = await ensure.handler(
      { slug: 'client-read', tool_slugs: ['note_to_page'] },
      { ownerId: 'o1', surface: { kind: 'client', loginId: 'c1' } },
    );
    expect(errorOf(res)).toMatch(/only the owner changes its tools/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('control: an agent may still add to an admin group, and re-send what a client group holds', async () => {
    h.selectQueue.push([EXISTING_GROUP]);
    await ensure.handler({ slug: 'geo-tools', tool_slugs: ['note_to_page'] }, agentCtx);
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ toolSlugs: ['geocode', 'note_to_page'] }),
    );
    h.selectQueue.push([CLIENT_READ]);
    const res = await ensure.handler(
      { slug: 'client-read', tool_slugs: ['client_shared_open'] },
      agentCtx,
    );
    expect(outputOf(res)).toMatchObject({ created: false });
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe('agent_grant_tool_group', () => {
  const AGENT = { id: 'a1', groups: ['core'] };
  const GROUP = { id: 'g1', toolSlugs: ['geocode', 'note_to_page'] };

  it('scopes BOTH lookups to the caller, and the agent update to the found row', async () => {
    // Two owner-scoped selects guard this grant: the agent and the group. Drop
    // either clause and a caller could widen a stranger's agent, or hand their
    // own agent a stranger's group by naming its slug.
    h.selectQueue.push([AGENT], [GROUP]);
    await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, ctx);
    expect(paramsOf(h.selectWheres[0])).toEqual(expect.arrayContaining(['o1', 'responder']));
    expect(paramsOf(h.selectWheres[1])).toEqual(expect.arrayContaining(['o1', 'geo-tools']));
    expect(paramsOf(h.updateWheres[0])).toContain('a1');
  });

  it('scopes the requester lookup when an AGENT initiates the grant', async () => {
    h.selectQueue.push([AGENT], [GROUP], [{ id: 'req1' }]);
    h.insertReturning.mockResolvedValue([{ id: 'p1' }]);
    await grant.handler({ agent_slug: 'responder', group_slug: 'geo-tools' }, agentCtx);
    expect(paramsOf(h.selectWheres[2])).toEqual(expect.arrayContaining(['o1', 'toolsmith']));
  });

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

describe('agent_set_thinking_effort', () => {
  // A higher tier raises an agent's spend on every turn, so the guards match
  // the grant: no self-change, and an agent asking waits for the operator.
  it('refuses an unknown effort before any lookup', async () => {
    const res = await setEffort.handler({ agent_slug: 'responder', effort: 'extreme' }, ctx);
    expect(errorOf(res)).toMatch(/effort must be one of: inherit, off, low/);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('refuses an agent changing its own effort BEFORE any lookup', async () => {
    const res = await setEffort.handler({ agent_slug: 'toolsmith', effort: 'max' }, agentCtx);
    expect(errorOf(res)).toMatch(/cannot change its own thinking effort/);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('an operator call writes the tier, owner-scoped, to the found row', async () => {
    h.selectQueue.push([{ id: 'a1', thinkingEffort: null }]);
    const res = await setEffort.handler({ agent_slug: 'responder', effort: 'high' }, ctx);
    expect(outputOf(res)).toEqual({ agent_slug: 'responder', thinking_effort: 'high' });
    expect(paramsOf(h.selectWheres[0])).toEqual(expect.arrayContaining(['o1', 'responder']));
    expect(h.updateSet).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: 'high' }));
    expect(paramsOf(h.updateWheres[0])).toContain('a1');
  });

  it("'inherit' clears the column to null", async () => {
    h.selectQueue.push([{ id: 'a1', thinkingEffort: 'low' }]);
    const res = await setEffort.handler({ agent_slug: 'responder', effort: 'inherit' }, ctx);
    expect(outputOf(res)).toEqual({ agent_slug: 'responder', thinking_effort: null });
    expect(h.updateSet).toHaveBeenCalledWith(expect.objectContaining({ thinkingEffort: null }));
  });

  it('an unchanged value writes nothing', async () => {
    h.selectQueue.push([{ id: 'a1', thinkingEffort: 'off' }]);
    const res = await setEffort.handler({ agent_slug: 'responder', effort: 'off' }, ctx);
    expect(outputOf(res)).toMatchObject({ unchanged: true });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('reports an unknown agent without writing', async () => {
    h.selectQueue.push([]);
    const res = await setEffort.handler({ agent_slug: 'ghost', effort: 'low' }, ctx);
    expect(errorOf(res)).toMatch(/agent 'ghost' not found/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('parks an agent-initiated change at /pending instead of applying it', async () => {
    h.selectQueue.push([{ id: 'a1', thinkingEffort: null }], [{ id: 'req1' }]);
    h.insertReturning.mockResolvedValue([{ id: 'p1' }]);
    const res = await setEffort.handler({ agent_slug: 'responder', effort: 'max' }, agentCtx);
    expect(outputOf(res)).toMatchObject({ status: 'queued_for_approval', pending_id: 'p1' });
    expect(h.insert).toHaveBeenCalledWith(pendingToolCalls);
    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSlug: 'agent_set_thinking_effort',
        args: { agent_slug: 'responder', effort: 'max' },
        agentId: 'req1',
      }),
    );
    expect(notifyPendingCreated).toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});

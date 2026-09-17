/**
 * Behavioural tests for the toolsmith AUTHORING writes: api_tool_create,
 * api_tool_update, api_tool_test, api_docs_set, recipe_tool_create,
 * recipe_tool_test.
 *
 * These are the tools that let an agent mint new capabilities, so what is
 * worth pinning is every place the authoring boundary is enforced BEFORE a
 * row is written or a request leaves the box:
 *
 *  - create/update refuse reserved slugs, non-http kinds and shell rows before
 *    touching the store, and honour the owner's "require approval" preference
 *    by forcing requires_confirm on (create) and refusing to clear it (update).
 *  - api_tool_test / recipe_tool_test refuse the wrong kind WITHOUT
 *    dispatching. Testing a shell tool would be an unconfirmed execution
 *    side-channel; the refusal is the only thing in the way.
 *  - api_tool_test runs the REAL dispatcher against the REAL egress guard for
 *    one case, so a tool authored against a private address is refused before
 *    any socket opens. Everything else stubs the dispatcher.
 *  - api_docs_set records provenance and re-points the group at the stored
 *    file; recipe_tool_create rejects a chain that steps onto a forbidden,
 *    missing, shell or confirm-gated tool, reporting every violation at once.
 *
 * `toolRowBySlug` is private to the module, so the db select chain under it is
 * stubbed with a per-call queue. The crud layer, the integration accessors and
 * the vault are stubbed; slug rules, handler assembly, template warnings and
 * the recipe step classifier are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  /** Where clauses handed to the selects, in call order. Recorded rather than
   *  waved through: a `mockReturnThis()` where accepts any clause, so dropping
   *  the owner-id term from a lookup would leave this file green. */
  const selectWheres: unknown[] = [];
  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      selectWheres.push(clause);
      return this;
    }),
    limit,
  };
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn((_patch: Record<string, unknown>) => ({ where: updateWhere }));
  return {
    selectQueue,
    selectWheres,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: updateSet })),
    updateSet,
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, db: { ...actual.db, select: h.select, update: h.update } };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, loadProfilePreferences: vi.fn() };
});
vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return { ...actual, listApiKeys: vi.fn(), getApiKey: vi.fn(async () => null) };
});
vi.mock('./crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crud')>();
  return { ...actual, createTool: vi.fn(), updateTool: vi.fn(), listToolsForOwner: vi.fn() };
});
vi.mock('./integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration')>();
  return {
    ...actual,
    getGroupIntegration: vi.fn(),
    setGroupIntegration: vi.fn(),
    upsertApiDocsFile: vi.fn(),
  };
});
vi.mock('./dispatch-bridge', () => ({
  dispatchViaBridge: vi.fn(),
  registerToolDispatcher: vi.fn(),
}));

import { loadProfilePreferences } from '@mantle/content';
import { listApiKeys } from '@mantle/api-keys';
import { createTool, updateTool, listToolsForOwner } from './crud';
import {
  getGroupIntegration,
  setGroupIntegration,
  upsertApiDocsFile,
  API_DOCS_MAX_CHARS,
} from './integration';
import { dispatchViaBridge } from './dispatch-bridge';
import { paramsOf } from './test-support';
import { dispatchTool } from './dispatch';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const create = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_tool_create')!;
const update = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_tool_update')!;
const test = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_tool_test')!;
const docsSet = TOOLSMITH_TOOLS.find((t) => t.slug === 'api_docs_set')!;
const recipeCreate = TOOLSMITH_TOOLS.find((t) => t.slug === 'recipe_tool_create')!;
const recipeTest = TOOLSMITH_TOOLS.find((t) => t.slug === 'recipe_tool_test')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** A stored tool row of the given kind, as toolRowBySlug returns it. */
function row(kind: string, extra: Record<string, unknown> = {}) {
  const handler =
    kind === 'http'
      ? { kind, url: 'https://api.example.com/geocode', method: 'GET', ...extra }
      : kind === 'recipe'
        ? { kind, steps: [{ tool: 'note_get', input: {} }], ...extra }
        : kind === 'shell'
          ? { kind, cmd: 'ls', ...extra }
          : { kind, ...extra };
  return {
    id: 't1',
    ownerId: 'o1',
    slug: 'geo',
    name: 'Geo',
    description: 'Geocode',
    inputSchema: { type: 'object', properties: {} },
    handler,
    requiresConfirm: false,
    enabled: true,
  };
}

/** A tool-summary row as listToolsForOwner returns it. */
function summary(slug: string, kind: string, requiresConfirm = false, extra = {}) {
  return {
    slug,
    name: slug,
    description: slug,
    inputSchema: { type: 'object', properties: {} },
    handler: { kind, ...extra },
    requiresConfirm,
    enabled: true,
  };
}

const VALID = {
  slug: 'geocode',
  name: 'Geocode',
  description: 'Turn an address into coordinates',
  url: 'https://api.example.com/geocode?q={q}',
  method: 'GET',
  input_schema: { type: 'object', properties: { q: { type: 'string' } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.selectWheres.length = 0;
  vi.mocked(loadProfilePreferences).mockResolvedValue({ toolsmithRequireApproval: false } as never);
  vi.mocked(listApiKeys).mockResolvedValue([] as never);
  vi.mocked(createTool).mockImplementation(async (_o, input) => ({ ...input }) as never);
  vi.mocked(updateTool).mockImplementation(
    async (_o, _id, patch) =>
      ({ ...row('http'), ...patch, handler: patch.handler ?? row('http').handler }) as never,
  );
  vi.mocked(listToolsForOwner).mockResolvedValue([] as never);
  vi.mocked(getGroupIntegration).mockResolvedValue(null as never);
  vi.mocked(setGroupIntegration).mockResolvedValue({} as never);
  vi.mocked(upsertApiDocsFile).mockResolvedValue({
    nodeId: 'n1',
    filename: 'weather-tools.md',
    chars: 120,
    capturedAt: '2026-09-03T00:00:00.000Z',
  } as never);
  vi.mocked(dispatchViaBridge).mockResolvedValue({ ok: true, output: { lat: 1 } } as never);
});

describe('api_tool_create', () => {
  it.each([
    ['an uppercase slug', 'Geocode', /slug must be lowercase/],
    ['a slug with spaces', 'geo code', /slug must be lowercase/],
    ['the reserved ask_human slug', 'ask_human', /reserved for runner-queue approval/],
    ['the reserved run_budget slug', 'run_budget', /reserved for runner-queue approval/],
  ])('refuses %s without writing', async (_label, slug, re) => {
    expect(errorOf(await create.handler({ ...VALID, slug }, ctx))).toMatch(re);
    expect(createTool).not.toHaveBeenCalled();
  });

  it('requires name and description, and refuses an unknown method', async () => {
    expect(errorOf(await create.handler({ ...VALID, name: ' ' }, ctx))).toMatch(
      /name and description are required/,
    );
    expect(errorOf(await create.handler({ ...VALID, method: 'HEAD' }, ctx))).toMatch(
      /method must be one of/,
    );
    expect(createTool).not.toHaveBeenCalled();
  });

  it('refuses a url that is not absolute http(s) when no group supplies a base', async () => {
    expect(errorOf(await create.handler({ ...VALID, url: '/geocode' }, ctx))).toMatch(/url/);
    expect(errorOf(await create.handler({ ...VALID, url: 'ftp://x/y' }, ctx))).toMatch(/url/);
    expect(createTool).not.toHaveBeenCalled();
  });

  it('stores an http handler under the caller, enabled and not gated by default', async () => {
    const res = await create.handler({ ...VALID, timeout_ms: 5000 }, ctx);
    expect(createTool).toHaveBeenCalledWith('o1', {
      slug: 'geocode',
      name: 'Geocode',
      description: 'Turn an address into coordinates',
      inputSchema: VALID.input_schema,
      handler: {
        kind: 'http',
        url: 'https://api.example.com/geocode?q={q}',
        method: 'GET',
        timeoutMs: 5000,
      },
      requiresConfirm: false,
      enabled: true,
    });
    expect(outputOf(res)).toMatchObject({ slug: 'geocode', created: true, warnings: [] });
    expect(outputOf(res).next).toMatch(/api_tool_test/);
  });

  it('forces the confirm gate on when the owner requires approval, whatever the agent asked', async () => {
    vi.mocked(loadProfilePreferences).mockResolvedValue({
      toolsmithRequireApproval: true,
    } as never);
    await create.handler({ ...VALID, requires_confirm: false }, ctx);
    expect(createTool).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ requiresConfirm: true }),
    );
  });

  it('warns about a {param} the schema never declares and a secret ref the vault lacks', async () => {
    const res = await create.handler(
      {
        ...VALID,
        input_schema: { type: 'object', properties: {} },
        headers: { 'x-api-key': '{{secret:example/default}}' },
      },
      ctx,
    );
    const warnings = outputOf(res).warnings as string[];
    expect(warnings).toEqual([
      expect.stringMatching(/\{q\} is not declared in input_schema/),
      expect.stringMatching(
        /secret ref \{\{secret:example\/default\}\} has no matching vault entry/,
      ),
    ]);
    expect(listApiKeys).toHaveBeenCalledWith('o1');
  });

  it('refuses an unknown group_slug BEFORE creating anything', async () => {
    const res = await create.handler({ ...VALID, group_slug: 'nope' }, ctx);
    expect(errorOf(res)).toMatch(/tool group 'nope' not found/);
    expect(getGroupIntegration).toHaveBeenCalledWith('o1', 'nope');
    expect(createTool).not.toHaveBeenCalled();
  });

  it('refuses to author into a connector group, whose membership the sync owns', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({
      id: 'g1',
      slug: 'mcp-github',
      name: 'GitHub',
      toolSlugs: [],
      integration: { service: 'github', mcp: { url: 'https://x' } },
    } as never);
    expect(errorOf(await create.handler({ ...VALID, group_slug: 'mcp-github' }, ctx))).toMatch(
      /connector group/,
    );
    expect(createTool).not.toHaveBeenCalled();
  });

  it('folds the group base URL + credential into the STORED handler and joins the group', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({
      id: 'g1',
      slug: 'weather-tools',
      name: 'Weather',
      toolSlugs: ['current'],
      integration: {
        service: 'openweathermap',
        baseUrl: 'https://api.openweathermap.org/data/2.5',
        secretRef: 'openweathermap/default',
        authTemplate: { query: { appid: '{{secret:openweathermap/default}}' } },
      },
    } as never);
    h.selectQueue.push([{ id: 'g1', toolSlugs: ['current'] }]);
    vi.mocked(listApiKeys).mockResolvedValue([
      { service: 'openweathermap', label: 'default', masked: '***' },
    ] as never);

    const res = await create.handler(
      { ...VALID, slug: 'forecast', url: '/forecast?q={q}', group_slug: 'weather-tools' },
      ctx,
    );

    // The dispatcher is untouched: what is stored is exactly what will run.
    expect(createTool).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        handler: expect.objectContaining({
          url: 'https://api.openweathermap.org/data/2.5/forecast?q={q}',
          query: { appid: '{{secret:openweathermap/default}}' },
        }),
      }),
    );
    // Membership: the group's list gains the new slug, existing ones kept.
    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ toolSlugs: ['current', 'forecast'] }),
    );
    expect(outputOf(res)).toMatchObject({
      slug: 'forecast',
      group_slug: 'weather-tools',
      added_to_group: true,
      warnings: [],
    });
  });

  it('maps a duplicate-slug insert to the update hint', async () => {
    vi.mocked(createTool).mockRejectedValue(
      new Error('duplicate key value violates unique constraint "tools_owner_slug_uq"'),
    );
    expect(errorOf(await create.handler(VALID, ctx))).toMatch(
      /'geocode' already exists — use api_tool_update/,
    );
  });
});

describe('api_tool_update', () => {
  it('scopes the slug lookup to the caller', async () => {
    // `toolRowBySlug` is the only thing standing between a slug and another
    // owner's authored tool; the patch is then applied by the row id it
    // returned. Drop `eq(tools.ownerId, ...)` and a shared slug is editable
    // across brains.
    h.selectQueue.push([row('http')]);
    await update.handler({ slug: 'geo', enabled: false }, ctx);
    expect(paramsOf(h.selectWheres[0])).toEqual(expect.arrayContaining(['o1', 'geo']));
  });

  it('reports an unknown slug without writing', async () => {
    expect(errorOf(await update.handler({ slug: 'ghost', enabled: false }, ctx))).toMatch(
      /'ghost' not found/,
    );
    expect(updateTool).not.toHaveBeenCalled();
  });

  it('refuses a shell tool BEFORE applying any field, even enabled/requires_confirm', async () => {
    // Flipping either flag here would let an agent strip the operator gate
    // off a destructive shell tool.
    h.selectQueue.push([row('shell')]);
    expect(errorOf(await update.handler({ slug: 'geo', requires_confirm: false }, ctx))).toMatch(
      /shell tools are human-only/,
    );
    expect(updateTool).not.toHaveBeenCalled();
  });

  it.each([
    ['builtin', /code-backed/],
    ['recipe', /aren't patched in place/],
    ['mcp', /mirror the remote server/],
  ])('refuses a definition change on a %s tool but still allows the flags', async (kind, re) => {
    h.selectQueue.push([row(kind)]);
    expect(errorOf(await update.handler({ slug: 'geo', url: 'https://x/y' }, ctx))).toMatch(re);
    expect(updateTool).not.toHaveBeenCalled();

    h.selectQueue.push([row(kind)]);
    vi.mocked(updateTool).mockResolvedValue({ ...row(kind), enabled: false } as never);
    const res = await update.handler({ slug: 'geo', enabled: false }, ctx);
    expect(updateTool).toHaveBeenCalledWith('o1', 't1', { enabled: false });
    expect(outputOf(res)).toMatchObject({ slug: 'geo', updated: true });
  });

  it('rebuilds the http handler on top of the EXISTING one, keeping unchanged fields', async () => {
    h.selectQueue.push([row('http', { timeoutMs: 9000, headers: { a: 'b' } })]);
    await update.handler({ slug: 'geo', url: 'https://api.example.com/v2/geocode' }, ctx);
    expect(updateTool).toHaveBeenCalledWith('o1', 't1', {
      handler: {
        kind: 'http',
        url: 'https://api.example.com/v2/geocode',
        method: 'GET',
        headers: { a: 'b' },
        timeoutMs: 9000,
      },
    });
  });

  it('clears the body template on body: null and the header map on {}', async () => {
    h.selectQueue.push([row('http', { body: '{"q": {q}}', headers: { a: 'b' } })]);
    await update.handler({ slug: 'geo', body: null, headers: {} }, ctx);
    const patch = vi.mocked(updateTool).mock.calls[0]![2];
    expect(patch.handler).not.toHaveProperty('body');
    expect(patch.handler).not.toHaveProperty('headers');
  });

  it('with require-approval ON, may tighten the gate but never clear it', async () => {
    vi.mocked(loadProfilePreferences).mockResolvedValue({
      toolsmithRequireApproval: true,
    } as never);
    h.selectQueue.push([row('http')]);
    await update.handler({ slug: 'geo', requires_confirm: false }, ctx);
    // The clearing request is dropped from the patch entirely.
    expect(updateTool).toHaveBeenCalledWith('o1', 't1', {});

    h.selectQueue.push([row('http')]);
    await update.handler({ slug: 'geo', requires_confirm: true }, ctx);
    expect(updateTool).toHaveBeenLastCalledWith('o1', 't1', { requiresConfirm: true });
  });

  it('with require-approval OFF, honours the agent either way', async () => {
    h.selectQueue.push([row('http')]);
    await update.handler({ slug: 'geo', requires_confirm: false }, ctx);
    expect(updateTool).toHaveBeenCalledWith('o1', 't1', { requiresConfirm: false });
  });

  it('refuses to re-home a connector-mirrored tool via group_slug', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({
      id: 'g1',
      slug: 'bundle',
      name: 'Bundle',
      toolSlugs: [],
      integration: null,
    } as never);
    h.selectQueue.push([row('http', { openapi: { connector: 'c1' } })]);
    expect(errorOf(await update.handler({ slug: 'geo', group_slug: 'bundle' }, ctx))).toMatch(
      /connector-mirrored tools stay in their connector's group/,
    );
    expect(updateTool).not.toHaveBeenCalled();
  });
});

describe('api_tool_test', () => {
  it('reports an unknown slug without dispatching', async () => {
    expect(errorOf(await test.handler({ slug: 'ghost' }, ctx))).toMatch(/'ghost' not found/);
    expect(dispatchViaBridge).not.toHaveBeenCalled();
  });

  it.each(['shell', 'builtin', 'recipe', 'mcp'])(
    'refuses a %s tool WITHOUT dispatching it',
    async (kind) => {
      // "Testing" anything but http would be an unconfirmed execution
      // side-channel; the refusal has to come before the dispatcher.
      h.selectQueue.push([row(kind)]);
      expect(errorOf(await test.handler({ slug: 'geo', input: {} }, ctx))).toMatch(
        new RegExp(`only runs http tools — 'geo' is ${kind}`),
      );
      expect(dispatchViaBridge).not.toHaveBeenCalled();
    },
  );

  it('dispatches the stored row as the CALLER and reports the response', async () => {
    const stored = row('http');
    h.selectQueue.push([stored]);
    const res = await test.handler({ slug: 'geo', input: { q: 'Cape Town' } }, ctx);
    expect(dispatchViaBridge).toHaveBeenCalledWith(
      stored,
      { q: 'Cape Town' },
      { ownerId: 'o1', step: undefined },
    );
    const out = outputOf(res);
    expect(out).toMatchObject({ slug: 'geo', test_passed: true, response: { lat: 1 } });
    expect(typeof out.duration_ms).toBe('number');
  });

  it('reports a failed call as a PASSED tool call with test_passed false', async () => {
    // The test tool succeeded at its job (it ran the tool); the tool failed.
    h.selectQueue.push([row('http')]);
    vi.mocked(dispatchViaBridge).mockResolvedValue({
      ok: false,
      error: '401 Unauthorized',
    } as never);
    const out = outputOf(await test.handler({ slug: 'geo' }, ctx));
    expect(out).toMatchObject({ test_passed: false, error: '401 Unauthorized' });
  });

  it('never opens a socket to a private address: the real dispatcher refuses first', async () => {
    // Real dispatch → real safeFetch → real egress guard. A tool authored
    // against the cloud-metadata endpoint must fail before fetch is called.
    vi.mocked(dispatchViaBridge).mockImplementation(dispatchTool);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    h.selectQueue.push([row('http', { url: 'http://169.254.169.254/latest/meta-data/' })]);

    const out = outputOf(await test.handler({ slug: 'geo', input: {} }, ctx));

    expect(out.test_passed).toBe(false);
    expect(String(out.error)).toMatch(/private\/internal address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('api_docs_set', () => {
  const MD = '## GET /weather\n\nReturns current conditions for a city. Auth: appid query param.';
  const GROUP = {
    id: 'g1',
    slug: 'weather-tools',
    name: 'Weather',
    toolSlugs: ['current'],
    integration: { service: 'openweathermap', baseUrl: 'https://api.openweathermap.org' },
  };

  it('refuses a bad group slug and an unknown group before storing anything', async () => {
    expect(errorOf(await docsSet.handler({ group_slug: 'Bad Slug', markdown: MD }, ctx))).toMatch(
      /group_slug must be lowercase/,
    );
    expect(errorOf(await docsSet.handler({ group_slug: 'nope', markdown: MD }, ctx))).toMatch(
      /tool group 'nope' not found/,
    );
    expect(upsertApiDocsFile).not.toHaveBeenCalled();
    expect(setGroupIntegration).not.toHaveBeenCalled();
  });

  it('refuses markdown too short to be documentation, and a non-http source_url', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(GROUP as never);
    expect(
      errorOf(await docsSet.handler({ group_slug: 'weather-tools', markdown: 'see docs' }, ctx)),
    ).toMatch(/too short/);
    expect(
      errorOf(
        await docsSet.handler(
          { group_slug: 'weather-tools', markdown: MD, source_url: 'openweathermap.org' },
          ctx,
        ),
      ),
    ).toMatch(/source_url must start with http/);
    expect(upsertApiDocsFile).not.toHaveBeenCalled();
  });

  it('stores the file under the caller with provenance and re-points the group at it', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(GROUP as never);
    const res = await docsSet.handler(
      { group_slug: 'weather-tools', markdown: MD, source_url: 'https://openweathermap.org/api' },
      ctx,
    );
    expect(upsertApiDocsFile).toHaveBeenCalledWith({
      ownerId: 'o1',
      groupSlug: 'weather-tools',
      markdown: MD,
      service: 'openweathermap',
      sourceUrl: 'https://openweathermap.org/api',
    });
    expect(setGroupIntegration).toHaveBeenCalledWith('o1', 'weather-tools', {
      service: 'openweathermap',
      docsNodeId: 'n1',
      docsUpdatedAt: '2026-09-03T00:00:00.000Z',
      docsSourceUrl: 'https://openweathermap.org/api',
    });
    expect(outputOf(res)).toMatchObject({
      group_slug: 'weather-tools',
      file: 'files/api-docs/weather-tools.md',
      chars: 120,
      stored: true,
      warnings: [],
    });
  });

  it('still stores docs on a group with no binding, recording the slug as service and warning', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue({ ...GROUP, integration: null } as never);
    const res = await docsSet.handler({ group_slug: 'weather-tools', markdown: MD }, ctx);
    expect(upsertApiDocsFile).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'weather-tools' }),
    );
    expect(outputOf(res).warnings).toEqual([expect.stringMatching(/had no integration binding/)]);
  });

  it('warns when the docs exceed the stored-file cap', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(GROUP as never);
    const res = await docsSet.handler(
      { group_slug: 'weather-tools', markdown: 'x'.repeat(API_DOCS_MAX_CHARS + 1) },
      ctx,
    );
    expect(outputOf(res).warnings).toEqual([expect.stringMatching(/clipped/)]);
  });

  it('surfaces a file-layer failure without re-pointing the group', async () => {
    vi.mocked(getGroupIntegration).mockResolvedValue(GROUP as never);
    vi.mocked(upsertApiDocsFile).mockRejectedValue(new Error('files root missing'));
    expect(errorOf(await docsSet.handler({ group_slug: 'weather-tools', markdown: MD }, ctx))).toBe(
      'files root missing',
    );
    expect(setGroupIntegration).not.toHaveBeenCalled();
  });
});

describe('recipe_tool_create', () => {
  const STEPS = [
    { tool: 'note_get', input: { id: '{note_id}' }, as: 'note' },
    { tool: 'page_create', input: { title: '$note.title', body: '$note.body' } },
  ];
  const VALID_RECIPE = {
    slug: 'note_to_page',
    name: 'Note to page',
    description: 'Turn a note into a page',
    input_schema: { type: 'object', properties: { note_id: { type: 'string' } } },
    steps: STEPS,
  };
  const OWNED = [summary('note_get', 'builtin'), summary('page_create', 'builtin')];

  it('refuses bad, forbidden and reserved slugs without writing', async () => {
    expect(errorOf(await recipeCreate.handler({ ...VALID_RECIPE, slug: 'Bad' }, ctx))).toMatch(
      /slug must be lowercase/,
    );
    expect(
      errorOf(await recipeCreate.handler({ ...VALID_RECIPE, slug: 'run_terminal' }, ctx)),
    ).toMatch(/is reserved/);
    expect(
      errorOf(await recipeCreate.handler({ ...VALID_RECIPE, slug: 'ask_human' }, ctx)),
    ).toMatch(/reserved for runner-queue/);
    expect(createTool).not.toHaveBeenCalled();
  });

  it('rejects the chain, listing EVERY violating step, and writes nothing', async () => {
    vi.mocked(listToolsForOwner).mockResolvedValue([
      summary('note_get', 'builtin'),
      summary('deploy', 'shell'),
      summary('pay', 'http', true),
    ] as never);
    const res = await recipeCreate.handler(
      {
        ...VALID_RECIPE,
        steps: [
          { tool: 'note_get' },
          { tool: 'deploy' },
          { tool: 'pay' },
          { tool: 'ghost' },
          { tool: 'run_terminal' },
        ],
      },
      ctx,
    );
    const err = errorOf(res);
    expect(err).toMatch(/recipe rejected/);
    expect(err).toMatch(/step 1: /);
    expect(err).toMatch(/step 2: /);
    expect(err).toMatch(/step 3: /);
    expect(err).toMatch(/step 4: /);
    expect(err).not.toMatch(/step 0: /);
    expect(listToolsForOwner).toHaveBeenCalledWith('o1');
    expect(createTool).not.toHaveBeenCalled();
  });

  it('stores a recipe handler under the caller and reports the chain', async () => {
    vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
    const res = await recipeCreate.handler({ ...VALID_RECIPE, output: '$1' }, ctx);
    expect(createTool).toHaveBeenCalledWith('o1', {
      slug: 'note_to_page',
      name: 'Note to page',
      description: 'Turn a note into a page',
      inputSchema: VALID_RECIPE.input_schema,
      handler: { kind: 'recipe', steps: STEPS, output: '$1' },
      requiresConfirm: false,
      enabled: true,
    });
    expect(outputOf(res)).toMatchObject({
      slug: 'note_to_page',
      created: true,
      steps: ['note_get', 'page_create'],
      warnings: [],
    });
  });

  it('warns about a {param} no schema property declares, but still creates', async () => {
    vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
    const res = await recipeCreate.handler(
      { ...VALID_RECIPE, input_schema: { type: 'object', properties: {} } },
      ctx,
    );
    expect(outputOf(res).warnings).toEqual([
      expect.stringMatching(/\{note_id\} is used in a step/),
    ]);
    expect(createTool).toHaveBeenCalled();
  });

  it('forces the confirm gate on when the owner requires approval', async () => {
    vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
    vi.mocked(loadProfilePreferences).mockResolvedValue({
      toolsmithRequireApproval: true,
    } as never);
    await recipeCreate.handler({ ...VALID_RECIPE, requires_confirm: false }, ctx);
    expect(createTool).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ requiresConfirm: true }),
    );
  });

  it('maps a duplicate-slug insert to the delete-and-recreate hint', async () => {
    vi.mocked(listToolsForOwner).mockResolvedValue(OWNED as never);
    vi.mocked(createTool).mockRejectedValue(new Error('duplicate key'));
    expect(errorOf(await recipeCreate.handler(VALID_RECIPE, ctx))).toMatch(
      /already exists — use api_tool_delete/,
    );
  });
});

describe('recipe_tool_test', () => {
  it('reports an unknown slug without dispatching', async () => {
    expect(errorOf(await recipeTest.handler({ slug: 'ghost' }, ctx))).toMatch(/'ghost' not found/);
    expect(dispatchViaBridge).not.toHaveBeenCalled();
  });

  it.each(['http', 'shell', 'builtin'])(
    'refuses a %s tool WITHOUT dispatching it',
    async (kind) => {
      h.selectQueue.push([row(kind)]);
      expect(errorOf(await recipeTest.handler({ slug: 'geo' }, ctx))).toMatch(
        new RegExp(`only runs recipe tools — 'geo' is ${kind}`),
      );
      expect(dispatchViaBridge).not.toHaveBeenCalled();
    },
  );

  it('dispatches the recipe row as the CALLER and reports pass or fail', async () => {
    const stored = row('recipe');
    h.selectQueue.push([stored]);
    const res = await recipeTest.handler({ slug: 'geo', input: { note_id: 'n1' } }, ctx);
    expect(dispatchViaBridge).toHaveBeenCalledWith(
      stored,
      { note_id: 'n1' },
      { ownerId: 'o1', step: undefined },
    );
    expect(outputOf(res)).toMatchObject({ test_passed: true, response: { lat: 1 } });

    h.selectQueue.push([stored]);
    vi.mocked(dispatchViaBridge).mockResolvedValue({ ok: false, error: 'step 1 failed' } as never);
    expect(outputOf(await recipeTest.handler({ slug: 'geo' }, ctx))).toMatchObject({
      test_passed: false,
      error: 'step 1 failed',
    });
  });
});

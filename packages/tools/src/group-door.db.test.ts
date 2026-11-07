/**
 * A group takes only what an agent may grant, and any change to what a group
 * other workspaces hold gives them waits for a person, whichever tool asks: its
 * list, its own fields, a tool's definition or delete, a tool made under a name
 * a list holds. On a real, migrated Postgres, through the one gate, with a turn's
 * caller and the agent's context.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/group-door.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a group takes only what an agent may grant', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']> | undefined;
  let m: typeof import('@mantle/db');
  let dispatch: typeof import('./dispatch');
  let callers: typeof import('./gate-callers');
  let grants: typeof import('./agent-grants');
  let pending: typeof import('./pending');
  const admin = randomUUID();
  const tag = `gd${randomUUID().slice(0, 6)}`;
  // An agent of Admin that holds its own group, and an assistant of another
  // workspace that holds a second one.
  const OWN_AGENT = `${tag}-own`;
  const OWN_GROUP = `${tag}-own-group`;
  const HELD_GROUP = `${tag}-held-group`;
  const HTTP = `${tag}_http`;
  const RECIPE = `${tag}_recipe`;
  const MCP = `${tag}_mcp`;
  const MIRROR = `${tag}_mirror`;
  const SHELL = `${tag}_shell`;
  let anchor = '';

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    await su`insert into auth.users (id, email, password_hash, role)
      values (${admin}, ${`${tag}-a@example.invalid`}, 'x', 'admin')`;
    anchor = await ts.ensureTestAnchor(su);
    await ts.ensureAdminUsers(su, [admin]);
    const [team] = await su<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${anchor}, ${`${tag} Team`}) returning id::text`;
    const insertTool = async (slug: string, handler: Record<string, unknown>) => {
      await su!`insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, 'd', ${JSON.stringify(handler)}::jsonb,
                '{"type":"object","properties":{}}'::jsonb)`;
    };
    const http = { kind: 'http', url: 'https://api.example.invalid/x', method: 'GET' };
    await insertTool(HTTP, http);
    await insertTool(`${HTTP}_2`, http);
    await insertTool(RECIPE, { kind: 'recipe', steps: [{ tool: 'note_get', input: {} }] });
    await insertTool(MCP, { kind: 'mcp', group: `mcp-${tag}`, toolName: 'x' });
    await insertTool(MIRROR, { ...http, openapi: { connector: 'c1' } });
    await insertTool(SHELL, { kind: 'shell', command: 'true' });
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled) values
      (${anchor}, ${OWN_GROUP}, 'own', '{}', true),
      (${anchor}, ${HELD_GROUP}, 'held', ${[`${HTTP}_2`]}, true)`;
    await su`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs) values
      (${anchor}, ${OWN_AGENT}, 'own', 'm', 'p', ${[OWN_GROUP]})`;
    await su`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, workspace_id)
      values (${anchor}, ${`${tag}-team`}, 'team', 'm', 'p', ${[HELD_GROUP]}, ${team!.id})`;
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    dispatch = await import('./dispatch');
    callers = await import('./gate-callers');
    grants = await import('./agent-grants');
    pending = await import('./pending');
    await import('./gate-narrowers');
    await import('./builtins');
    // The builtin rows: note_get, and the tools an approval judges again.
    const { seedBuiltinTools } = await import('./seed');
    await m.asSystem(() => seedBuiltinTools(anchor), 'test');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** A tool call of an in-brain agent, in its turn (or as its run's item). */
  const turn = async (
    slug: string,
    input: Record<string, unknown>,
    caller = callers.turnCaller(),
  ) => {
    const scope = await m.loginScopeFor(admin);
    return m.withTurnScope(
      scope,
      () =>
        dispatch.dispatchTool(
          { slug, handler: { kind: 'builtin', ref: slug }, inputSchema: {} } as unknown as Tool,
          input,
          {
            ownerId: anchor,
            surface: { kind: 'web', loginId: admin },
            caller,
            agent: { slug: OWN_AGENT, depth: 1, delegateTo: [] },
          },
        ),
      { writes: true },
    );
  };
  /** The same call by a person, in the dev tool console. */
  const asPerson = async (slug: string, input: Record<string, unknown>) =>
    m.runInRequestSlot(async () => {
      expect(
        m.enterRequestScope(await m.loginScopeFor(admin), { writes: true, drafts: false }),
      ).toBe(true);
      return dispatch.dispatchTool(
        { slug, handler: { kind: 'builtin', ref: slug }, inputSchema: {} } as unknown as Tool,
        input,
        {
          ownerId: anchor,
          surface: { kind: 'web', loginId: admin },
          caller: callers.ownerWebCaller(),
        },
      );
    });
  const toolsIn = async (group: string) =>
    (
      await su!<{ tool_slugs: string[] }[]>`
        select tool_slugs from tool_groups where owner_id = ${anchor} and slug = ${group}`
    )[0]?.tool_slugs ?? [];
  const toolExists = async (slug: string) =>
    (await su!`select 1 from tools where owner_id = ${anchor} and slug = ${slug}`).length > 0;
  const held = async (id: string) =>
    (
      await su!<{ tool_slug: string; status: string }[]>`
        select tool_slug, status from pending_tool_calls where id = ${id}`
    )[0];
  /** The call waits; the id of its row. */
  const parked = async (
    slug: string,
    input: Record<string, unknown>,
    caller = callers.turnCaller(),
  ) => {
    const res = await turn(slug, input, caller);
    expect(res, JSON.stringify(res)).toMatchObject({
      ok: true,
      output: { status: 'queued_for_approval' },
    });
    return String((res as { output: { pending_id: string } }).output.pending_id);
  };
  /** A person approves the row, and it applies. */
  const approve = async (id: string) => {
    const decided = await pending.approvePendingCall(anchor, id, { approverLoginId: admin });
    expect(decided, id).toMatchObject({ status: 'approved' });
    expect(decided?.error, id).toBeFalsy();
  };
  /** A new integration group the assistant of the other workspace holds. */
  const heldIntegration = async () => {
    const group = `${tag}-api-${randomUUID().slice(0, 6)}`;
    const made = await turn('tool_group_ensure', {
      slug: group,
      name: 'Api',
      tool_slugs: [],
      service: 'example',
      base_url: 'https://api.example.invalid/v1',
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    await su!`update agents set tool_group_slugs = array_append(tool_group_slugs, ${group})
               where owner_id = ${anchor} and slug = ${`${tag}-team`}`;
    return group;
  };
  /** A new http tool, in `group`'s list when one is named. */
  const newTool = async (group?: string) => {
    const slug = `${tag}_t${randomUUID().slice(0, 8)}`;
    await su!`insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, ${slug}, ${slug}, 'd',
              ${su!.json({ kind: 'http', url: 'https://api.example.invalid/t', method: 'GET' })},
              '{"type":"object","properties":{}}'::jsonb)`;
    if (group) await nameInList(group, slug);
    return slug;
  };
  /** A new recipe row. A step may name any slug, as a stored recipe can. */
  const newRecipe = (slug: string, steps: Record<string, unknown>[]) =>
    su!`insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, ${slug}, ${slug}, 'd', ${su!.json({ kind: 'recipe', steps } as never)},
              '{"type":"object","properties":{}}'::jsonb)`;
  const nameInList = (group: string, slug: string) =>
    su!`update tool_groups set tool_slugs = array_append(tool_slugs, ${slug})
         where owner_id = ${anchor} and slug = ${group}`;
  const toolRow = async (slug: string) =>
    (
      await su!<
        { description: string; requires_confirm: boolean; enabled: boolean; on: boolean }[]
      >`select description, requires_confirm, enabled, external_access is not null as on
          from tools where owner_id = ${anchor} and slug = ${slug}`
    )[0];
  const groupRow = async (group: string) =>
    (
      await su!<{ name: string; description: string; base_url: string | null }[]>`
        select name, description, integration->>'baseUrl' as base_url
          from tool_groups where owner_id = ${anchor} and slug = ${group}`
    )[0];
  /** The rows a call of `tool` left, in every status. */
  const parksOf = async (tool: string, argSlug: string) =>
    (
      await su!<{ id: string }[]>`select id::text from pending_tool_calls
        where owner_id = ${anchor} and tool_slug = ${tool} and args->>'slug' = ${argSlug}`
    ).length;
  const requireApproval = (on: boolean) =>
    su!`insert into profiles (user_id, preferences)
        values (${anchor}, ${su!.json({ toolsmithRequireApproval: on })})
        on conflict (user_id) do update
          set preferences = profiles.preferences || excluded.preferences`;
  const NEW_HTTP = {
    name: 'New',
    description: 'A new tool',
    url: 'https://api.example.invalid/new',
    method: 'GET',
  };
  const SKILL_BODY =
    'Call the example tool for the current value, and pass the unit each time: the service gives no default for it.';
  const skillOf = async (group: string) =>
    (
      await su!<{ instructions: string }[]>`
        select instructions from skills where owner_id = ${anchor} and slug = ${`api-${group}`}`
    )[0]?.instructions;

  it('a builtin stays out of a group an agent holds, and out of its grant', async () => {
    const res = await turn('api_tool_update', { slug: 'note_get', group_slug: OWN_GROUP });
    const grant = await grants.loadAgentGrant(anchor, { slug: OWN_AGENT });
    expect({
      reason: !res.ok && /may only contain http or recipe tools.*refused: note_get/.test(res.error),
      inGroup: (await toolsIn(OWN_GROUP)).includes('note_get'),
      inGrant: grant?.toolSlugs.has('note_get'),
    }).toEqual({ reason: true, inGroup: false, inGrant: false });
  });

  it('a builtin stays out through tool_group_ensure too, on a list and on a new group', async () => {
    const res = await turn('tool_group_ensure', { slug: OWN_GROUP, tool_slugs: ['note_get'] });
    expect(res.ok ? '' : res.error).toMatch(/refused: note_get/);
    expect(await toolsIn(OWN_GROUP)).not.toContain('note_get');
    const fresh = `${tag}-fresh`;
    const made = await turn('tool_group_ensure', {
      slug: fresh,
      name: 'Fresh',
      tool_slugs: ['note_get'],
    });
    expect(made.ok ? '' : made.error).toMatch(/refused: note_get/);
    expect(await toolsIn(fresh)).toEqual([]);
  });

  it('a slug no tool has stays out', async () => {
    const slug = `${tag}_later`;
    const res = await turn('tool_group_ensure', { slug: OWN_GROUP, tool_slugs: [slug] });
    expect(res.ok ? '' : res.error).toMatch(new RegExp(`refused: ${slug}.*make it first`));
    expect(await toolsIn(OWN_GROUP)).not.toContain(slug);
  });

  it('a seed leaves a tool of another kind that holds a builtin slug as it is, and counts it', async () => {
    const slug = 'note_get';
    const url = 'https://api.example.invalid/mine';
    // This test's own row holds the slug: the seeded row steps aside for it.
    const aside = await su!<{ id: string }[]>`
      update tools set slug = ${`${tag}_aside`}
       where owner_id = ${anchor} and slug = ${slug} returning id::text`;
    const [own] = await su!<{ id: string }[]>`
      insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, ${slug}, ${slug}, 'd', ${su!.json({ kind: 'http', url, method: 'GET' })},
              '{"type":"object","properties":{}}'::jsonb)
      returning id::text`;
    try {
      const { seedBuiltinTools } = await import('./seed');
      const seeded = await m.asSystem(() => seedBuiltinTools(anchor), 'test');
      const [after] = await su!<{ kind: string; url: string }[]>`
        select handler->>'kind' as kind, handler->>'url' as url from tools where id = ${own!.id}`;
      expect(after).toEqual({ kind: 'http', url });
      expect(seeded.skipped).toBe(1);
    } finally {
      await su!`delete from tools where id = ${own!.id}`;
      for (const row of aside) await su!`update tools set slug = ${slug} where id = ${row.id}`;
    }
  });

  it.each([
    ['a connector tool', MCP, `refused: ${MCP}`],
    ['a mirrored tool', MIRROR, `refused: ${MIRROR}`],
    ['a shell tool', SHELL, 'shell tools are human-only'],
  ])('%s stays out of a group', async (_what, slug, refusal) => {
    const res = await turn('api_tool_update', { slug, group_slug: OWN_GROUP });
    expect(res.ok ? '' : res.error).toContain(refusal);
    expect(await toolsIn(OWN_GROUP)).not.toContain(slug);
  });

  it('a person in the console is held to the same list', async () => {
    const res = await asPerson('api_tool_update', { slug: 'note_get', group_slug: OWN_GROUP });
    expect(res.ok ? '' : res.error).toMatch(/refused: note_get/);
    expect(await toolsIn(OWN_GROUP)).not.toContain('note_get');
  });

  it('a recipe and an http tool join a group the agent holds, as tool_group_ensure has them', async () => {
    const recipe = await turn('api_tool_update', { slug: RECIPE, group_slug: OWN_GROUP });
    expect(recipe.ok, JSON.stringify(recipe)).toBe(true);
    const http = await turn('api_tool_update', { slug: HTTP, group_slug: OWN_GROUP });
    expect(http.ok, JSON.stringify(http)).toBe(true);
    expect(await toolsIn(OWN_GROUP)).toEqual(expect.arrayContaining([RECIPE, HTTP]));
  });

  it('the Toolsmith flow holds: a group, a tool into it, a test of the tool, a grant', async () => {
    const group = `${tag}-flow`;
    const made = await turn('tool_group_ensure', {
      slug: group,
      name: 'Flow',
      tool_slugs: [],
      service: 'example',
      base_url: 'https://api.example.invalid/v1',
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const slug = `${tag}_flow`;
    const created = await turn('api_tool_create', {
      slug,
      name: 'Flow',
      description: 'A tool authored into a group',
      url: '/flow',
      method: 'GET',
      group_slug: group,
    });
    expect(created, JSON.stringify(created)).toMatchObject({
      ok: true,
      output: { created: true, added_to_group: true },
    });
    expect(await toolsIn(group)).toEqual([slug]);
    // The real dispatcher ran: the host does not resolve, so the test says so.
    const tested = await turn('api_tool_test', { slug });
    expect(tested, JSON.stringify(tested)).toMatchObject({
      ok: true,
      output: { slug, test_passed: false },
    });
    const granted = await turn('agent_grant_tool_group', {
      agent_slug: `${tag}-team`,
      group_slug: group,
    });
    expect(granted, JSON.stringify(granted)).toMatchObject({
      ok: true,
      output: { status: 'queued_for_approval' },
    });
  });

  describe('api_tool_update reads an integration group whatever the scope sees of it', () => {
    it('a tool joins one no other workspace holds, at once', async () => {
      const group = `${tag}-api-${randomUUID().slice(0, 6)}`;
      const made = await turn('tool_group_ensure', {
        slug: group,
        name: 'Own api',
        tool_slugs: [],
        service: 'example',
        base_url: 'https://api.example.invalid/v1',
      });
      expect(made.ok, JSON.stringify(made)).toBe(true);
      const slug = await newTool();
      const res = await turn('api_tool_update', { slug, group_slug: group });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { updated: true } });
      expect(await toolsIn(group)).toEqual([slug]);
    });

    it('a tool joining a held one waits, and its approval applies', async () => {
      const group = await heldIntegration();
      const slug = await newTool();
      const id = await parked('api_tool_update', { slug, group_slug: group });
      expect(await toolsIn(group)).toEqual([]);
      await approve(id);
      expect(await toolsIn(group)).toEqual([slug]);
    });
  });

  it('api_docs_set refuses a plain group and leaves it plain', async () => {
    const plain = `${tag}-plain-${randomUUID().slice(0, 6)}`;
    await su!`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${plain}, 'plain', '{}', true)`;
    const markdown = '## GET /x\n\nReturns the current value. Auth: a bearer token in the header.';
    const res = await turn('api_docs_set', { group_slug: plain, markdown });
    expect(res.ok ? '' : res.error).toMatch(/is not an integration.*tool_group_ensure/);
    const [row] = await su!<{ integration: unknown }[]>`
      select integration from tool_groups where owner_id = ${anchor} and slug = ${plain}`;
    expect(row?.integration).toBeNull();
  });

  it('a change to a group another workspace holds waits for a person, whichever tool asks', async () => {
    const viaUpdate = await parked('api_tool_update', {
      slug: HTTP,
      description: 'Held with its group',
      group_slug: HELD_GROUP,
    });
    const newSlug = `${tag}_new`;
    const viaCreate = await parked('api_tool_create', {
      slug: newSlug,
      name: 'New',
      description: 'A new tool into a held group',
      url: 'https://api.example.invalid/new',
      method: 'GET',
      group_slug: HELD_GROUP,
    });
    const viaEnsure = await parked('tool_group_ensure', {
      slug: HELD_GROUP,
      tool_slugs: [RECIPE],
    });
    expect(await held(viaUpdate)).toEqual({ tool_slug: 'api_tool_update', status: 'pending' });
    expect(await held(viaCreate)).toEqual({ tool_slug: 'api_tool_create', status: 'pending' });
    expect(await held(viaEnsure)).toEqual({ tool_slug: 'tool_group_ensure', status: 'pending' });

    // Nothing moved while it waits.
    expect(await toolsIn(HELD_GROUP)).toEqual([`${HTTP}_2`]);
    expect(await toolExists(newSlug)).toBe(false);
    const [desc] = await su!<{ description: string }[]>`
      select description from tools where owner_id = ${anchor} and slug = ${HTTP}`;
    expect(desc?.description).toBe('d');

    // A person approves each, and each applies whole. The login whose agent
    // asked decides its own calls, so a second Admin's park can be approved.
    for (const id of [viaUpdate, viaCreate, viaEnsure]) await approve(id);
    expect(await toolsIn(HELD_GROUP)).toEqual(
      expect.arrayContaining([`${HTTP}_2`, HTTP, newSlug, RECIPE]),
    );
    const [after] = await su!<{ description: string }[]>`
      select description from tools where owner_id = ${anchor} and slug = ${HTTP}`;
    expect(after?.description).toBe('Held with its group');
  });

  it('a run item waits as a turn does, and its approval applies', async () => {
    const group = await heldIntegration();
    const id = await parked(
      'tool_group_ensure',
      { slug: group, tool_slugs: [RECIPE] },
      callers.runCaller(),
    );
    expect(await toolsIn(group)).toEqual([]);
    await approve(id);
    expect(await toolsIn(group)).toEqual([RECIPE]);
  });

  it("a park keeps the asking login and its scope, and its approval runs (a second Admin's agent)", async () => {
    const group = `${tag}-grant`;
    const made = await turn('tool_group_ensure', { slug: group, name: 'Grant', tool_slugs: [] });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const grantId = await parked('agent_grant_tool_group', {
      agent_slug: `${tag}-team`,
      group_slug: group,
    });
    const effortId = await parked('agent_set_thinking_effort', {
      agent_slug: `${tag}-team`,
      effort: 'high',
    });
    const fresh = `${tag}_park`;
    await su!`insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, ${fresh}, ${fresh}, 'd',
              ${JSON.stringify({ kind: 'http', url: 'https://api.example.invalid/p', method: 'GET' })}::jsonb,
              '{"type":"object","properties":{}}'::jsonb)`;
    const updateId = await parked('api_tool_update', { slug: fresh, group_slug: HELD_GROUP });
    for (const id of [grantId, effortId, updateId]) {
      const [row] = await su!<{ login_id: string | null; origin: { scope: unknown } }[]>`
        select login_id::text, origin from pending_tool_calls where id = ${id}`;
      expect(row?.login_id, id).toBe(admin);
      expect(row?.origin.scope, id).toMatchObject({ loginId: admin });
    }
    await approve(grantId);
    await approve(effortId);
    await approve(updateId);
    const [team] = await su!<{ tool_group_slugs: string[]; thinking_effort: string | null }[]>`
      select tool_group_slugs, thinking_effort from agents
       where owner_id = ${anchor} and slug = ${`${tag}-team`}`;
    expect(team?.tool_group_slugs).toContain(group);
    expect(team?.thinking_effort).toBe('high');
    expect(await toolsIn(HELD_GROUP)).toContain(fresh);
  });

  it('a usage skill on a group another workspace holds waits for a person, and its approval writes it', async () => {
    const group = await heldIntegration();
    const id = await parked('api_skill_set', { group_slug: group, body: SKILL_BODY });
    expect(await held(id)).toEqual({ tool_slug: 'api_skill_set', status: 'pending' });
    expect(await skillOf(group)).toBeUndefined();
    await approve(id);
    expect(await skillOf(group)).toBe(SKILL_BODY);
    const [row] = await su!<{ integration: { skillSlug?: string } }[]>`
      select integration from tool_groups where owner_id = ${anchor} and slug = ${group}`;
    expect(row?.integration.skillSlug).toBe(`api-${group}`);
  });

  it('a usage skill on a group no other workspace holds does not wait', async () => {
    const group = `${tag}-api-own`;
    const made = await turn('tool_group_ensure', {
      slug: group,
      name: 'Own api',
      tool_slugs: [],
      service: 'example',
      base_url: 'https://api.example.invalid/v1',
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const res = await turn('api_skill_set', { group_slug: group, body: SKILL_BODY });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { created: true } });
    expect(await skillOf(group)).toBe(SKILL_BODY);
  });

  it("an agent's definition edit of a tool in a held group waits, its group re-sent or not, and its approval applies once", async () => {
    const slug = await newTool(HELD_GROUP);
    const plain = await parked('api_tool_update', { slug, description: 'Edited alone' });
    const resent = await parked('api_tool_update', {
      slug,
      name: 'Edited name',
      group_slug: HELD_GROUP,
    });
    expect(await held(plain)).toEqual({ tool_slug: 'api_tool_update', status: 'pending' });
    expect((await toolRow(slug))?.description).toBe('d');
    await approve(plain);
    await approve(resent);
    expect((await toolRow(slug))?.description).toBe('Edited alone');
    expect((await toolsIn(HELD_GROUP)).filter((t) => t === slug)).toEqual([slug]);
    expect(await parksOf('api_tool_update', slug)).toBe(2);
  });

  it('one call that edits a tool in a held group and joins another parks one row', async () => {
    const slug = await newTool(HELD_GROUP);
    const other = `${tag}-held-other`;
    await su!`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${other}, 'other', '{}', true)`;
    await su!`update agents set tool_group_slugs = array_append(tool_group_slugs, ${other})
               where owner_id = ${anchor} and slug = ${`${tag}-team`}`;
    await parked('api_tool_update', { slug, description: 'Both', group_slug: other });
    expect(await parksOf('api_tool_update', slug)).toBe(1);
    expect(await toolsIn(other)).toEqual([]);
  });

  it('a definition edit on a group no other workspace holds does not wait', async () => {
    const slug = await newTool(OWN_GROUP);
    const res = await turn('api_tool_update', { slug, description: 'Edited in place' });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { updated: true } });
    expect((await toolRow(slug))?.description).toBe('Edited in place');
  });

  it.each([
    ['requires_confirm: true', { requires_confirm: true }, { requires_confirm: true }],
    ['enabled: false', { enabled: false }, { enabled: false }],
    ['external_access: false', { external_access: false }, { on: false }],
  ])('an agent tightening with %s on a held tool goes on at once', async (_what, input, state) => {
    const slug = await newTool(HELD_GROUP);
    const res = await turn('api_tool_update', { slug, ...input });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { updated: true } });
    expect(await toolRow(slug)).toMatchObject(state);
    expect(await parksOf('api_tool_update', slug)).toBe(0);
  });

  it.each([
    ['its name', { name: 'Renamed' }],
    ['its description', { description: 'New words' }],
    ['its base URL', { base_url: 'https://api.example.invalid/v2' }],
  ])(
    'an agent changing %s of a held group with no tool waits, and its approval writes it',
    async (_what, fields) => {
      const group = await heldIntegration();
      const before = await groupRow(group);
      const id = await parked('tool_group_ensure', { slug: group, tool_slugs: [], ...fields });
      expect(await groupRow(group)).toEqual(before);
      await approve(id);
      const after = await groupRow(group);
      expect(after).not.toEqual(before);
      if ('name' in fields) expect(after?.name).toBe(fields.name);
      if ('description' in fields) expect(after?.description).toBe(fields.description);
      if ('base_url' in fields) expect(after?.base_url).toBe(fields.base_url);
    },
  );

  it('one ensure that changes the list and a field parks one row, and writes both once', async () => {
    const group = await heldIntegration();
    const id = await parked('tool_group_ensure', {
      slug: group,
      tool_slugs: [RECIPE],
      name: 'Both',
    });
    expect(await parksOf('tool_group_ensure', group)).toBe(1);
    await approve(id);
    expect(await toolsIn(group)).toEqual([RECIPE]);
    expect((await groupRow(group))?.name).toBe('Both');
  });

  it('an ensure that sends what the group already says does not wait', async () => {
    const group = await heldIntegration();
    const res = await turn('tool_group_ensure', {
      slug: group,
      tool_slugs: [],
      name: (await groupRow(group))!.name,
    });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { created: false } });
    expect(await parksOf('tool_group_ensure', group)).toBe(0);
  });

  it('a person in the console changes a held group at once', async () => {
    const group = await heldIntegration();
    const res = await asPerson('tool_group_ensure', {
      slug: group,
      tool_slugs: [],
      name: 'By hand',
    });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect((await groupRow(group))?.name).toBe('By hand');
  });

  it("a tool made under a name a held group's list holds waits, by api_tool_create and recipe_tool_create", async () => {
    const http = `${tag}_named_http`;
    const recipe = `${tag}_named_recipe`;
    await nameInList(HELD_GROUP, http);
    await nameInList(HELD_GROUP, recipe);
    const madeHttp = await parked('api_tool_create', { slug: http, ...NEW_HTTP });
    const madeRecipe = await parked('recipe_tool_create', {
      slug: recipe,
      name: 'New',
      description: 'A new recipe',
      steps: [{ tool: 'note_get', input: {} }],
    });
    expect(await toolExists(http)).toBe(false);
    expect(await toolExists(recipe)).toBe(false);
    await approve(madeHttp);
    await approve(madeRecipe);
    expect(await toolExists(http)).toBe(true);
    expect(await toolExists(recipe)).toBe(true);
  });

  describe("who, by the caller's entry", () => {
    /** The same call in a turn, with no agent on its context. */
    const noAgent = async (slug: string, input: Record<string, unknown>) => {
      const scope = await m.loginScopeFor(admin);
      return m.withTurnScope(
        scope,
        () =>
          dispatch.dispatchTool(
            { slug, handler: { kind: 'builtin', ref: slug }, inputSchema: {} } as unknown as Tool,
            input,
            {
              ownerId: anchor,
              surface: { kind: 'web', loginId: admin },
              caller: callers.turnCaller(),
            },
          ),
        { writes: true },
      );
    };

    it('a turn with no agent on its context waits, keeps its login, and its approval applies', async () => {
      const group = await heldIntegration();
      const res = await noAgent('api_skill_set', { group_slug: group, body: SKILL_BODY });
      expect(res, JSON.stringify(res)).toMatchObject({
        ok: true,
        output: { status: 'queued_for_approval' },
      });
      expect(await skillOf(group)).toBeUndefined();
      const id = String((res as { output: { pending_id: string } }).output.pending_id);
      const [row] = await su!<{ login_id: string | null; agent_id: string | null }[]>`
        select login_id::text, agent_id::text from pending_tool_calls where id = ${id}`;
      expect(row).toEqual({ login_id: admin, agent_id: null });
      await approve(id);
      expect(await skillOf(group)).toBe(SKILL_BODY);
    });

    it('recipe_tool_test with a door tool writes nothing and queues nothing', async () => {
      const group = await heldIntegration();
      const slug = `${tag}_t${randomUUID().slice(0, 8)}`;
      await newRecipe(slug, [
        { tool: 'api_skill_set', input: { group_slug: group, body: SKILL_BODY } },
      ]);
      const res = await turn('recipe_tool_test', { slug, input: {} });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { test_passed: false } });
      expect(JSON.stringify(res)).toMatch(/can't be used in a recipe/);
      expect(await skillOf(group)).toBeUndefined();
    });

    it('a person in the console writes a usage skill on a held group at once', async () => {
      const group = await heldIntegration();
      const res = await asPerson('api_skill_set', { group_slug: group, body: SKILL_BODY });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { created: true } });
      expect(await skillOf(group)).toBe(SKILL_BODY);
    });
  });

  describe('a test of a tool with the confirm flag', () => {
    /** A recipe that makes one note, and the title that counts it. */
    const noteRecipe = async (requiresConfirm: boolean) => {
      const slug = `${tag}_t${randomUUID().slice(0, 8)}`;
      const title = `${tag} note ${randomUUID().slice(0, 8)}`;
      await newRecipe(slug, [{ tool: 'note_create', input: { title, content: 'x' } }]);
      await su!`update tools set requires_confirm = ${requiresConfirm}
                 where owner_id = ${anchor} and slug = ${slug}`;
      return { slug, title };
    };
    const notesTitled = async (title: string) =>
      (await su!`select 1 from nodes where owner_id = ${anchor} and title = ${title}`).length;
    /** A call that writes an item names who it runs as. */
    const asLogin = <T>(fn: () => Promise<T>) =>
      m.runAsActor(m.loginActor(admin, 'rw'), fn) as Promise<T>;
    const gatedHttp = async () => {
      const slug = await newTool();
      await su!`update tools set requires_confirm = true
                 where owner_id = ${anchor} and slug = ${slug}`;
      return slug;
    };
    const resultOf = async (id: string) =>
      (
        await su!<{ result: unknown }[]>`
          select result from pending_tool_calls where id = ${id}`
      )[0]?.result;

    it('a recipe: a turn waits and nothing runs; its approval runs it once', async () => {
      const { slug, title } = await noteRecipe(true);
      const id = await asLogin(() => parked('recipe_tool_test', { slug, input: {} }));
      expect(await held(id)).toMatchObject({ tool_slug: 'recipe_tool_test', status: 'pending' });
      expect(await notesTitled(title)).toBe(0);
      await approve(id);
      expect(await notesTitled(title)).toBe(1);
      expect(await parksOf('recipe_tool_test', slug)).toBe(1);
    });

    it('an http tool: a turn waits; its approval runs it', async () => {
      const slug = await gatedHttp();
      const id = await parked('api_tool_test', { slug, input: {} });
      expect(await held(id)).toMatchObject({ tool_slug: 'api_tool_test', status: 'pending' });
      expect(await resultOf(id)).toBeNull();
      await approve(id);
      // The real dispatcher ran: the host does not resolve, so the test says so.
      expect(JSON.stringify(await resultOf(id))).toContain('test_passed');
      expect(await parksOf('api_tool_test', slug)).toBe(1);
    });

    it('a tool with no flag: a turn runs it at once', async () => {
      const { slug, title } = await noteRecipe(false);
      const res = await asLogin(() => turn('recipe_tool_test', { slug, input: {} }));
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { test_passed: true } });
      expect(await notesTitled(title)).toBe(1);
      expect(await parksOf('recipe_tool_test', slug)).toBe(0);
    });

    it('a person in the console runs it at once', async () => {
      const { slug, title } = await noteRecipe(true);
      const res = await asLogin(() => asPerson('recipe_tool_test', { slug, input: {} }));
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { test_passed: true } });
      expect(await notesTitled(title)).toBe(1);
      expect(await parksOf('recipe_tool_test', slug)).toBe(0);
    });

    it('an MCP client runs it at once', async () => {
      // The MCP surface's policy source, as the surface registers it.
      if (!m.hasPolicySource('mcp-tool')) {
        const { builtinPolicy, toGatePolicy } = await import('./tool-policy');
        m.registerPolicySource('mcp-tool', (ref) => {
          const p = builtinPolicy(ref.name);
          return p ? toGatePolicy(p) : null;
        });
      }
      const slug = await gatedHttp();
      const caller = callers.mcpToolCaller(
        Object.freeze({
          actor: m.loginActor(admin, 'rw'),
          via: 'oauth' as const,
          loginId: admin,
          write: true,
          admin: { holdsAdmin: true, areas: new Set<string>(['connectors']) },
          createHome: null,
        }),
      );
      const res = await turn('api_tool_test', { slug, input: {} }, caller);
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { slug } });
      expect(JSON.stringify(res)).toContain('test_passed');
      expect(await parksOf('api_tool_test', slug)).toBe(0);
    });
  });

  describe('a group holds what a recipe in its list steps through', () => {
    /** A new http tool that only a recipe in `group` reaches, `depth` recipes down. */
    const reachedTool = async (group: string, depth = 1) => {
      const slug = await newTool();
      let step = slug;
      for (let i = 0; i < depth; i++) {
        const recipe = `${tag}_r${randomUUID().slice(0, 8)}`;
        await newRecipe(recipe, [{ tool: step, input: {} }]);
        step = recipe;
      }
      await nameInList(group, step);
      return slug;
    };

    it.each([
      ['one recipe down', 1],
      ['two recipes down', 2],
    ])('its definition edit waits, %s, and its approval applies', async (_what, depth) => {
      const slug = await reachedTool(HELD_GROUP, depth);
      const id = await parked('api_tool_update', { slug, description: 'Through a recipe' });
      expect((await toolRow(slug))?.description).toBe('d');
      await approve(id);
      expect((await toolRow(slug))?.description).toBe('Through a recipe');
    });

    it('its delete waits', async () => {
      const slug = await reachedTool(HELD_GROUP);
      const id = await parked('api_tool_delete', { slug });
      expect(await toolExists(slug)).toBe(true);
      await approve(id);
      expect(await toolExists(slug)).toBe(false);
    });

    it('a tool made under a slug a held recipe steps through waits', async () => {
      const slug = `${tag}_t${randomUUID().slice(0, 8)}`;
      const recipe = `${tag}_r${randomUUID().slice(0, 8)}`;
      await newRecipe(recipe, [{ tool: slug, input: {} }]);
      await nameInList(HELD_GROUP, recipe);
      await parked('api_tool_create', { slug, ...NEW_HTTP });
      expect(await toolExists(slug)).toBe(false);
    });

    it('control: through a recipe in a group no other workspace holds, it does not wait', async () => {
      const slug = await reachedTool(OWN_GROUP);
      const res = await turn('api_tool_update', { slug, description: 'Own recipe' });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { updated: true } });
      expect((await toolRow(slug))?.description).toBe('Own recipe');
    });

    it('two recipes that step through each other end the walk', async () => {
      const a = `${tag}_r${randomUUID().slice(0, 8)}`;
      const b = `${tag}_r${randomUUID().slice(0, 8)}`;
      await newRecipe(a, [{ tool: b, input: {} }]);
      await newRecipe(b, [{ tool: a, input: {} }]);
      const res = await turn('api_tool_delete', { slug: a });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { deleted: true } });
    });
  });

  describe('a group this call makes', () => {
    /** A slug the other workspace's assistant already lists, with no group yet. */
    const grantedName = async () => {
      const group = `${tag}-named-${randomUUID().slice(0, 6)}`;
      await su!`update agents set tool_group_slugs = array_append(tool_group_slugs, ${group})
                 where owner_id = ${anchor} and slug = ${`${tag}-team`}`;
      return group;
    };

    it('under a name a grant already lists waits, and its approval makes it', async () => {
      const group = await grantedName();
      const id = await parked('tool_group_ensure', {
        slug: group,
        name: 'Named',
        tool_slugs: [RECIPE],
      });
      expect(await groupRow(group)).toBeUndefined();
      await approve(id);
      expect(await toolsIn(group)).toEqual([RECIPE]);
    });

    it('with no name is refused before the door, and queues nothing', async () => {
      const group = await grantedName();
      const res = await turn('tool_group_ensure', { slug: group, tool_slugs: [] });
      expect(res.ok ? '' : res.error).toMatch(/name is required/);
      expect(await parksOf('tool_group_ensure', group)).toBe(0);
    });

    it('under a name no grant lists goes on at once', async () => {
      const group = `${tag}-free-${randomUUID().slice(0, 6)}`;
      const res = await turn('tool_group_ensure', { slug: group, name: 'Free', tool_slugs: [] });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { created: true } });
    });
  });

  describe('a delete takes the name out', () => {
    it('a failure on the list leaves the row and the name: no half write', async () => {
      const group = `${tag}-fails`;
      const fn = `${tag}_refuse_list_write`;
      await su!`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
        values (${anchor}, ${group}, 'fails', '{}', true)`;
      const slug = await newTool(group);
      await su!.unsafe(`create function ${fn}() returns trigger language plpgsql as $f$
        begin raise exception 'the list refuses this write'; end $f$`);
      await su!.unsafe(`create trigger ${fn} before update on tool_groups for each row
        when (new.slug = '${group}') execute function ${fn}()`);
      try {
        const res = await asPerson('api_tool_delete', { slug });
        expect(res.ok, JSON.stringify(res)).toBe(false);
        expect(await toolExists(slug)).toBe(true);
        expect(await toolsIn(group)).toContain(slug);
      } finally {
        await su!.unsafe(`drop trigger ${fn} on tool_groups`);
        await su!.unsafe(`drop function ${fn}()`);
      }
    });

    it("an agent's delete of a tool in a held group waits; on approval the row and the name go", async () => {
      const slug = await newTool(HELD_GROUP);
      const id = await parked('api_tool_delete', { slug });
      expect(await toolExists(slug)).toBe(true);
      expect(await toolsIn(HELD_GROUP)).toContain(slug);
      await approve(id);
      expect(await toolExists(slug)).toBe(false);
      expect(await toolsIn(HELD_GROUP)).not.toContain(slug);
    });

    it('a tool made again is in no group, and joins a held group only through the door', async () => {
      const slug = await newTool(OWN_GROUP);
      const gone = await turn('api_tool_delete', { slug });
      expect(gone, JSON.stringify(gone)).toMatchObject({ ok: true, output: { deleted: true } });
      expect(await toolsIn(OWN_GROUP)).not.toContain(slug);
      const made = await turn('api_tool_create', { slug, ...NEW_HTTP });
      expect(made, JSON.stringify(made)).toMatchObject({ ok: true, output: { created: true } });
      expect(await toolsIn(OWN_GROUP)).not.toContain(slug);
      const id = await parked('api_tool_update', { slug, group_slug: HELD_GROUP });
      expect(await toolsIn(HELD_GROUP)).not.toContain(slug);
      await approve(id);
      expect(await toolsIn(HELD_GROUP)).toContain(slug);
    });

    it('a person in the console: the name leaves every list that holds it', async () => {
      const slug = await newTool(HELD_GROUP);
      await nameInList(OWN_GROUP, slug);
      const res = await asPerson('api_tool_delete', { slug });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, output: { deleted: true } });
      expect(await toolsIn(HELD_GROUP)).not.toContain(slug);
      expect(await toolsIn(OWN_GROUP)).not.toContain(slug);
    });
  });

  describe('confirm comes back with "require approval for agent-built tools"', () => {
    afterAll(() => requireApproval(false));

    it("an agent's definition edit turns it back on", async () => {
      await requireApproval(true);
      const slug = await newTool(OWN_GROUP);
      const res = await turn('api_tool_update', { slug, description: 'Edited by an agent' });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
      expect((await toolRow(slug))?.requires_confirm).toBe(true);
    });

    it("a person's edit in the console leaves it off", async () => {
      await requireApproval(true);
      const slug = await newTool(OWN_GROUP);
      const res = await asPerson('api_tool_update', { slug, description: 'Edited by hand' });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
      expect((await toolRow(slug))?.requires_confirm).toBe(false);
    });

    it('an approved edit leaves it off: the person looked at the whole call', async () => {
      await requireApproval(true);
      const slug = await newTool(HELD_GROUP);
      const id = await parked('api_tool_update', { slug, description: 'Looked at' });
      await approve(id);
      const row = await toolRow(slug);
      expect(row?.description).toBe('Looked at');
      expect(row?.requires_confirm).toBe(false);
    });

    it('with the setting off, an agent leaves it as it is', async () => {
      await requireApproval(false);
      const slug = await newTool(OWN_GROUP);
      await turn('api_tool_update', { slug, description: 'Setting off' });
      expect((await toolRow(slug))?.requires_confirm).toBe(false);
    });
  });

  describe('who approves a park', () => {
    it("the anchor approves a park another login asked, and it runs as that login's", async () => {
      const group = await heldIntegration();
      const id = await parked('tool_group_ensure', { slug: group, tool_slugs: [RECIPE] });
      const [row] = await su!<{ login_id: string | null }[]>`
        select login_id::text from pending_tool_calls where id = ${id}`;
      expect(row?.login_id).toBe(admin);
      const decided = await pending.approvePendingCall(anchor, id, { approverLoginId: anchor });
      expect(decided, id).toMatchObject({ status: 'approved' });
      expect(decided?.error, id).toBeFalsy();
      expect(await toolsIn(group)).toEqual([RECIPE]);
    });
  });
});

/**
 * A group takes only what an agent may grant: api_tool_update with group_slug
 * follows the same kinds as tool_group_ensure. On a real, migrated Postgres,
 * through the one gate, with a turn's caller and the agent's context.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/group-kinds.db.test.ts
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
  const admin = randomUUID();
  const tag = `gk${randomUUID().slice(0, 6)}`;
  const AGENT = `${tag}-agent`;
  const GROUP = `${tag}-group`;
  const HTTP = `${tag}_http`;
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
    const http = { kind: 'http', url: 'https://api.example.invalid/x', method: 'GET' };
    await su`insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, ${HTTP}, ${HTTP}, 'd', ${JSON.stringify(http)}::jsonb,
              '{"type":"object","properties":{}}'::jsonb)`;
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${GROUP}, 'own', '{}', true)`;
    await su`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${anchor}, ${AGENT}, 'own', 'm', 'p', ${[GROUP]})`;
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    dispatch = await import('./dispatch');
    callers = await import('./gate-callers');
    grants = await import('./agent-grants');
    await import('./gate-narrowers');
    await import('./builtins');
    const { seedBuiltinTools } = await import('./seed');
    await m.asSystem(() => seedBuiltinTools(anchor), 'test');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** A tool call of an in-brain agent, in its turn. */
  const turn = async (slug: string, input: Record<string, unknown>) => {
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
            agent: { slug: AGENT, depth: 1, delegateTo: [] },
          },
        ),
      { writes: true },
    );
  };
  const toolsInGroup = async () =>
    (
      await su!<{ tool_slugs: string[] }[]>`
        select tool_slugs from tool_groups where owner_id = ${anchor} and slug = ${GROUP}`
    )[0]?.tool_slugs ?? [];

  it('a builtin stays out of the group, and out of the grant', async () => {
    const res = await turn('api_tool_update', { slug: 'note_get', group_slug: GROUP });
    const grant = await grants.loadAgentGrant(anchor, { slug: AGENT });
    expect({
      refused: !res.ok,
      inGroup: (await toolsInGroup()).includes('note_get'),
      inGrant: grant?.toolSlugs.has('note_get'),
    }).toEqual({ refused: true, inGroup: false, inGrant: false });
  });

  it('an http tool still joins the group', async () => {
    const res = await turn('api_tool_update', { slug: HTTP, group_slug: GROUP });
    expect(res.ok).toBe(true);
    expect(await toolsInGroup()).toContain(HTTP);
  });
});

/**
 * Team delegation after 0187 (client logins audit A31), on a real, migrated
 * Postgres. 0187 turned row level security on for agents and tool groups;
 * a team turn delegates to the brain's ADMIN-level specialists, so under
 * `withViewer('team')` the two real reads delegation makes must still see an
 * admin agent and its tool groups:
 *
 *  - the delegate roster (packages/tools delegate-roster.ts), which reads
 *    the delegates and their groups for invoke_agent's description;
 *  - invoke_agent's agent load (invokeAgent), which must find the target.
 *
 * invokeAgent is driven only up to its key check: the test agent has no API
 * key, so a FOUND target answers "has no api_key_id configured" and a target
 * it cannot see answers "not found". No model is ever called (the chat
 * adapter is stood in and fails the test if reached).
 *
 * The contrast is the client role, which reads agents and tool groups by
 * level only: the same admin agent is not found there.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/team-delegation.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: () => {
    throw new Error('team-delegation test: no model may be called');
  },
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKey: vi.fn(async () => null),
  getApiKeyById: vi.fn(async () => null),
}));

describe.skipIf(!URL)('team delegation reaches admin agents under the team role', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let ownerId: string;
  const tag = `deleg-${randomUUID().slice(0, 8)}`;
  const agentSlug = `${tag}-specialist`;
  const groupSlug = `${tag}-group`;
  const groupName = `${tag} Specialist tools`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    await admin`insert into tool_groups (owner_id, slug, name, description, tool_slugs, audience)
      values (${ownerId}, ${groupSlug}, ${groupName}, 'Does the specialist work.', ${[]},
              'admin')`;
    await admin`insert into agents (owner_id, slug, name, model, provider, system_prompt,
                                    tool_group_slugs, audience, enabled)
      values (${ownerId}, ${agentSlug}, 'Specialist', 'fake/model', 'openrouter',
              'You are a specialist.', ${[groupSlug]}, 'admin', true)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from agents where owner_id = ${ownerId} and slug = ${agentSlug}`;
    await admin`delete from tool_groups where owner_id = ${ownerId} and slug = ${groupSlug}`;
    await m?.closeDb();
  });

  it('the delegate roster lists the admin agent and its group at team', async () => {
    const { buildDelegateRoster } = await import('@mantle/tools');
    const roster = await m.withViewer('team', () => buildDelegateRoster(ownerId, [agentSlug]));
    expect(roster).toContain(agentSlug);
    expect(roster).toContain(groupName);
    // The contrast: the client role reads agents by level, and this one is
    // an admin agent.
    expect(await m.withViewer('client', () => buildDelegateRoster(ownerId, [agentSlug]))).toBe('');
  });

  it("invoke_agent's agent load finds the admin agent at team", async () => {
    const { invokeAgent } = await import('./invoke-agent');
    const call = () =>
      invokeAgent({ ownerId, agentSlug, prompt: 'hello', depth: 1, parentTraceId: null });
    const team = await m.withViewer('team', call);
    expect(team.ok).toBe(false);
    expect(team.ok ? '' : team.error).toMatch(/has no api_key_id configured/);
    const client = await m.withViewer('client', call);
    expect(client.ok ? '' : client.error).toMatch(/not found/);
  });
});

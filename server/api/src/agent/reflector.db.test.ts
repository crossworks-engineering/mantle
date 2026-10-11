/**
 * The reflector neither wakes for nor reads a turn an MCP client answered as
 * the agent (channel 'mcp', written by responder_turn_record). Persona notes
 * must not learn from a test model's replies (Jason, 2026-10-05).
 *
 * Against a real, migrated Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/reflector.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('reflector skips mcp turns', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let reflector: typeof import('./reflector');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const other = randomUUID(); // a second Admin user (W7c fix round 1, M2)
  const agentId = randomUUID();
  const agentId2 = randomUUID();
  const since = new Date(Date.now() - 60_000);

  async function turn(
    direction: 'inbound' | 'outbound',
    channel: string,
    text: string,
    who: { login?: string; agent?: string } = {},
  ) {
    await m.db.execute(sqlTag`
      insert into assistant_messages (owner_id, agent_id, direction, text, channel, login_id)
      values (${owner}, ${who.agent ?? agentId}, ${direction}, ${text}, ${channel},
              ${who.login ?? null})`);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    reflector = await import('./reflector');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`refl-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin'),
             (${other}, ${`refl-${other.slice(0, 8)}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict do nothing`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, role)
      values (${agentId}, ${owner}, 'refl-test', 'Refl', 'fake/model', 'x', 'responder'),
             (${agentId2}, ${owner}, 'refl-test-2', 'Refl 2', 'fake/model', 'x', 'responder')`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from assistant_messages where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id in (${owner}, ${other})`);
  });

  it('a recorded mcp turn does not wake the reflector', async () => {
    await turn('inbound', 'mcp', 'MCP question');
    await turn('outbound', 'mcp', 'MCP reply from a test model');
    expect(await reflector.qualifyingAgents(owner, since)).toEqual([]);
  });

  it('a web turn wakes it, and the mcp turns stay out of what it reads', async () => {
    await turn('inbound', 'web', 'web question');
    await turn('outbound', 'web', 'web reply');
    const qualifying = await reflector.qualifyingAgents(owner, since);
    expect(qualifying.map((a) => a.id)).toEqual([agentId]);

    const turns = await reflector.loadReflectionTurns(owner, agentId);
    expect(turns.map((t) => t.text).sort()).toEqual(['web question', 'web reply']);
  });

  it('another user’s chat neither wakes it nor reaches what it reads (W7c fix round 1, M2)', async () => {
    await turn('inbound', 'web', 'second admin question', { login: other, agent: agentId2 });
    await turn('outbound', 'web', 'second admin reply', { login: other, agent: agentId2 });
    await turn('outbound', 'web', 'second admin private reply', { login: other });
    const qualifying = await reflector.qualifyingAgents(owner, since);
    expect(qualifying.map((a) => a.id)).not.toContain(agentId2);
    const turns = await reflector.loadReflectionTurns(owner, agentId);
    expect(turns.map((t) => t.text)).not.toContain('second admin private reply');
    expect(await reflector.loadReflectionTurns(owner, agentId2)).toEqual([]);
  });
});

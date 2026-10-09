/**
 * GET /api/member/mcp lists the connectors the member's own MCP really
 * offers (access matrix N10), on a real migrated Postgres. The screen used
 * its own rule: every connector tool at team level, write tools counted with
 * the member's Write switch off, and connectors listed while the team
 * responder held no tool, when the surface offers no tool at all. It now
 * reads the surface's own list (resolveLoginToolRows). Only the member
 * check is stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run member-mcp-connectors.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ anchor: '', member: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    anchorId: h.anchor,
    loginId: h.member,
    email: 'member@example.invalid',
    displayName: 'Member',
  })),
}));

describe.skipIf(!URL)("the member MCP screen's connectors", () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const member = randomUUID();
  const tag = `member-mcp-${anchor.slice(0, 8)}`;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const view = async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    return (await res.json()) as {
      connectors: Array<{ name: string; readTools: number; writeTools: number }>;
    };
  };
  const setWrite = (on: boolean) =>
    exec(sqlTag`update mcp_login_access set write_enabled = ${on} where login_id = ${member}`);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const { externalAccessHandlerSig } = await import('@mantle/tools');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    h.anchor = anchor;
    h.member = member;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    await exec(sqlTag`
      insert into profiles (user_id, preferences)
      values (${anchor}, '{"remoteMcpEnabled":true}'::jsonb)
      on conflict (user_id) do update set preferences = excluded.preferences`);
    await exec(sqlTag`
      insert into mcp_login_access (login_id, enabled, write_enabled) values (${member}, true, false)`);
    const handler = (toolName: string) => ({ kind: 'mcp', group: 'mcp-src', toolName });
    const mark = JSON.stringify({
      confirmedReadOnlyAt: new Date().toISOString(),
      by: { via: 'web' },
      handlerSig: externalAccessHandlerSig(handler('read') as never),
    });
    await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, input_schema, external_access) values
        (${anchor}, 'note_list', 'note_list', 'n', '{"kind":"builtin","ref":"note_list"}'::jsonb,
          '{"type":"object","properties":{}}'::jsonb, null),
        (${anchor}, 'mcp_src_read', 'r', 'reads', ${JSON.stringify(handler('read'))}::jsonb,
          '{"type":"object","properties":{}}'::jsonb, ${mark}::jsonb),
        (${anchor}, 'mcp_src_write', 'w', 'writes', ${JSON.stringify(handler('write'))}::jsonb,
          '{"type":"object","properties":{}}'::jsonb, null)`);
    const binding = JSON.stringify({
      service: 'mcp-src',
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration) values
        (${anchor}, 'g-team', 'g', ARRAY['note_list'], 'team', true, null),
        (${anchor}, 'mcp-src', 'Source', ARRAY['mcp_src_read','mcp_src_write'], 'team', true, ${binding}::jsonb)`);
    await exec(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, audience) values
        (${anchor}, 'team-responder', 't', 'm', 'p', ARRAY['g-team'], 'team')`);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from agents where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from mcp_login_access where login_id = ${member}`);
    await exec(sqlTag`delete from profiles where user_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id in (${anchor}, ${member})`);
    await exec(sqlTag`delete from auth.users where id in (${anchor}, ${member})`);
    await m.closeDb();
  }, 60_000);

  it('Write off: the read tool only, as the surface lists', async () => {
    await setWrite(false);
    expect((await view()).connectors).toEqual([
      expect.objectContaining({ name: 'Source', readTools: 1, writeTools: 0 }),
    ]);
  });

  it('Write on: the write tool too', async () => {
    await setWrite(true);
    try {
      expect((await view()).connectors).toEqual([
        expect.objectContaining({ name: 'Source', readTools: 1, writeTools: 1 }),
      ]);
    } finally {
      await setWrite(false);
    }
  });

  it('a responder with no tool of its own: the surface offers nothing, so no connector', async () => {
    await exec(sqlTag`
      update agents set tool_group_slugs = '{}' where owner_id = ${anchor} and slug = 'team-responder'`);
    try {
      expect((await view()).connectors).toEqual([]);
    } finally {
      await exec(sqlTag`
        update agents set tool_group_slugs = ARRAY['g-team']
        where owner_id = ${anchor} and slug = 'team-responder'`);
    }
  });
});

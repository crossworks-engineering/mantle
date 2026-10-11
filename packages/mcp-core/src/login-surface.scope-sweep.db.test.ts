/**
 * U5 for MCP (workspaces plan 20, W6a): every tool a non-Admin login's MCP
 * surface offers, called with that login's token, runs in the login's user
 * scope. The tool's own work is stood in (dispatchTool records the scope it
 * runs in); what is proved is the surface's one choke point, for every tool
 * the table offers a member with Write on and off.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/mcp-core/src/login-surface.scope-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { McpCaller } from './login-surface';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const seen = vi.hoisted(() => ({ calls: [] as { slug: string; scope: string; login: unknown }[] }));

vi.mock('@mantle/tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/tools')>();
  const db = await import('@mantle/db');
  return {
    ...orig,
    dispatchTool: async (row: { slug: string }) => {
      const s = db.currentScope();
      seen.calls.push({
        slug: row.slug,
        scope: s.kind,
        login: 'loginId' in s ? s.loginId : null,
      });
      return { ok: true, output: {} };
    },
  };
});

describe.skipIf(!URL)('MCP as a login: every tool runs in the login scope (U5)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ls: typeof import('./login-surface');
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const member = randomUUID();
  const tag = `u5mcp-${randomUUID().slice(0, 8)}`;

  const asMember = (write: boolean): McpCaller => ({
    role: 'member',
    anchorId: anchor,
    loginId: member,
    displayName: 'Test Member',
    via: 'token',
    write,
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ls = await import('./login-surface');
    sqlTag = (await import('drizzle-orm')).sql;
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const { TEAM_RESPONDER_SLUG } = await import('@mantle/runtime/assistant');
    const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, is_owner, role) values
        (${anchor}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member')`);
    await exec(sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`);
    await exec(sqlTag`select * from mantle_ws_migrate()`);
    const slugs = BUILTIN_TOOLS.map((t) => t.slug);
    for (const slug of slugs) {
      await exec(sqlTag`
        insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, ${`${slug} tool`},
          ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb,
          '{"type":"object","properties":{}}'::jsonb)
        on conflict do nothing`);
    }
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${anchor}, 'g-u5', 'g', ${`{${slugs.join(',')}}`}::text[], 'team', true)`);
    await exec(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, audience)
      values (${anchor}, ${TEAM_RESPONDER_SLUG}, 't', 'm', 'p', ARRAY['g-u5'], 'team')
      on conflict do nothing`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it.each([false, true])(
    'write %s: each offered tool dispatches in the member scope',
    async (write) => {
      const prepared = await ls.prepareCallerTools(asMember(write));
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(server, prepared);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 'test-client', version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(5);
      seen.calls.length = 0;
      for (const name of names) await c.callTool({ name, arguments: {} });
      const unscoped = seen.calls.filter((x) => x.scope !== 'user' || x.login !== member);
      expect(unscoped).toEqual([]);
      // Every offered tool reached the stand-in (none refused before it ran
      // except by its own argument checks).
      expect(seen.calls.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

/**
 * The one rule (packages/tools/src/person-only-acts.ts): an agent may tighten a
 * gate, never loosen one. So a person must really be able to do each act. Through
 * the full pipeline (runRoute) on a real, migrated database:
 *
 *  - an Admin user publishes a Recall map, confirms a prompt and restores a
 *    revision; a member is refused;
 *  - an agent writes a map and a card, and an edit on a published map serves at
 *    once, but nothing an agent sends publishes it;
 *  - an Admin user clears a tool's confirm, turns it back on and switches External
 *    access on, in Settings, in the dev tool console and by approving a held
 *    call; the anchor's own MCP client is refused the same acts;
 *  - that client acts at once on a group, which takes only what an agent may grant;
 *  - a history entry's id that is not a uuid names nothing: a 404, not a 500.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/person-acts-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Json = Record<string, any>;

describe.skipIf(!URL)('a person can do each act an agent may not', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | null = null;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let c: typeof import('@mantle/content');
  let mcp: typeof import('@mantle/mcp-core');

  const L = { owner: randomUUID(), member: randomUUID() };
  const W = randomUUID();
  const AGENT = { kind: 'agent', id: null, name: 'librarian' } as const;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:person-acts', fn) as Promise<T>;

  const route = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await runRoute(who, method, path, body);
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // Not JSON: the status says it.
    }
    return { status: res.status, json, text };
  };

  /** The anchor's own MCP client, over the real SDK. */
  const anchorMcp = async (name: string, args: Record<string, unknown>) => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'person-acts', version: '0' });
    mcp.registerMantleTools(server, L.owner, { transport: 'stdio' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'person-acts', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const r = (await m.runAsActor(m.loginActor(L.owner, 'owner'), () =>
        client.callTool({ name, arguments: args }),
      )) as { content?: { text?: string }[] };
      return (r.content ?? []).map((p) => p.text ?? '').join(' ');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      await client.close();
    }
  };

  /** A draft map an agent made, with a card it asked to make a prompt. */
  const agentDraft = async (title: string) =>
    sys(async () => {
      const made = await c.createRecallMap(
        L.owner,
        { title, enterWhen: `Working on ${title}` },
        AGENT,
      );
      await c.putRecallCard(
        L.owner,
        made.mapId,
        null,
        { title: 'Deploy', bodyMd: 'one', useWhen: 'deploying', prompt: true },
        AGENT,
        made.version,
      );
      return made.mapId;
    });
  const mapRow = async (nodeId: string) =>
    (
      await x<{ id: string; slug: string; version: number; published: boolean }>(
        sql`select id::text as id, slug, version, published from recall_maps where node_id = ${nodeId}`,
      )
    )[0]!;
  const homeIn = async (id: string, ws: string) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)`);
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'person-acts-routes-secret-at-least-32-chars';
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    c = await import('@mantle/content');
    mcp = await import('@mantle/mcp-core');
    for (const [who, id] of Object.entries(L)) {
      await ts.asSuperuser()(sql`
        insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`pa-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${who === 'owner' ? 'admin' : 'member'}, ${who})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sql`insert into workspaces (id, owner_id, name) values (${W}, ${L.owner}, 'Proj')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                 values (${W}, ${L.member}, true)`);
    await m.asSystem(() => t.seedBuiltinTools(L.owner), 'test');
    // The app is built on the first request: not inside a cell's time.
    await runRoute(null, 'GET', '/api/shares');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('an Admin user publishes a new map, and a member, Moderator of its home, is refused', async () => {
    const id = await agentDraft('Publishing');
    const before = await mapRow(id);
    expect(before.published).toBe(false);

    const member = await agentDraft('Member publish');
    await homeIn(member, W);
    const asMember = await route(L.member, 'PATCH', `/api/recall/maps/${member}`, {
      published: true,
      version: (await mapRow(member)).version,
    });
    expect(asMember.status, asMember.text).toBeGreaterThanOrEqual(400);
    expect(asMember.status).toBeLessThan(500);
    expect((await mapRow(member)).published).toBe(false);

    const asAdmin = await route(L.owner, 'PATCH', `/api/recall/maps/${id}`, {
      published: true,
      version: before.version,
    });
    expect(asAdmin.status, asAdmin.text).toBe(200);
    expect((await mapRow(id)).published).toBe(true);
  });

  it('an Admin user confirms a prompt and restores a revision', async () => {
    const id = await agentDraft('Confirming');
    const row = await mapRow(id);
    const confirmed = await route(L.owner, 'POST', `/api/recall/maps/${id}/cards/deploy/prompt`, {
      confirm: true,
      version: row.version,
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    const [card] = await x<{ kind: string; prompt_pending: boolean }>(
      sql`select kind::text as kind, prompt_pending from recall_nodes
            where map_id = ${row.id} and slug = 'deploy'`,
    );
    expect(card).toMatchObject({ kind: 'prompt', prompt_pending: false });

    const [rev] = await x<{ id: string }>(
      sql`select id::text as id from recall_revisions
            where map_id = ${row.id} and summary = 'prompt confirmed'`,
    );
    const restored = await route(L.owner, 'POST', `/api/recall/revisions/${rev!.id}/restore`);
    expect(restored.status, restored.text).toBe(200);
    const [back] = await x<{ kind: string; prompt_pending: boolean }>(
      sql`select kind::text as kind, prompt_pending from recall_nodes
            where map_id = ${row.id} and slug = 'deploy'`,
    );
    expect(back).toMatchObject({ kind: 'knowledge', prompt_pending: true });
  });

  it('an agent writes and edits, a live edit serves at once, and nothing it sends publishes', async () => {
    // The anchor's own MCP client: it starts a draft, and no field publishes it.
    const made = JSON.parse(
      await anchorMcp('recall_map_create', { title: 'From a client', enter_when: 'Some time' }),
    ) as Json;
    expect(made.published).toBe(false);
    const nodeId = String(made.id);
    const sent = await anchorMcp('recall_map_update', {
      map: made.map,
      title: 'Still a draft',
      published: true,
    });
    expect(sent).not.toMatch(/"published":\s*true/);
    expect((await mapRow(nodeId)).published).toBe(false);
    // The tool is gone, and its name finds nothing.
    expect(
      await anchorMcp('recall_map_publish', { map: made.map, published: true, version: 1 }),
    ).toMatch(/Tool recall_map_publish not found/);
    expect((await mapRow(nodeId)).published).toBe(false);

    // A person publishes it. After that an agent's edit serves at once.
    const before = await mapRow(nodeId);
    const pub = await route(L.owner, 'PATCH', `/api/recall/maps/${nodeId}`, {
      published: true,
      version: before.version,
    });
    expect(pub.status, pub.text).toBe(200);
    const put = await anchorMcp('recall_card_put', {
      map: made.map,
      title: 'Live card',
      body: 'Serves at once.',
    });
    expect(put).toMatch(/live-card/);
    const read = await anchorMcp('recall_go', { map: made.map, target: 'live-card' });
    expect(read).toMatch(/Serves at once\./);
    // The revision log records it, as an agent's.
    const [rev] = await x<{ actor_kind: string }>(
      sql`select actor_kind from recall_revisions
            where map_id = ${(await mapRow(nodeId)).id} and card_slug = 'live-card'`,
    );
    expect(rev?.actor_kind).toBe('agent');
  });

  describe('a tool in a group another workspace holds', () => {
    const insertHeld = async () => {
      const slug = `pa_door_${randomUUID().slice(0, 8)}`;
      const group = `pa-door-${randomUUID().slice(0, 8)}`;
      const [row] = await x<{ id: string }>(sql`
        insert into tools (owner_id, slug, name, description, handler)
        values (${L.owner}, ${slug}, 'n', 'd',
                ${JSON.stringify({ kind: 'http', url: 'https://api.example.test/x', method: 'GET' })}::jsonb)
        returning id::text as id`);
      await su(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
                   values (${L.owner}, ${group}, 'g', ARRAY[${slug}]::text[], true)`);
      await su(sql`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, workspace_id)
                   values (${L.owner}, ${group}, 'a', 'm', 'p', ARRAY[${group}]::text[], ${W})`);
      return { id: row!.id, slug, group };
    };
    const listOf = async (group: string) =>
      (
        await x<{ tool_slugs: string[] }>(sql`
        select tool_slugs from tool_groups where owner_id = ${L.owner} and slug = ${group}`)
      )[0]!.tool_slugs;
    const requireApproval = (on: boolean) =>
      su(sql`insert into profiles (user_id, preferences)
             values (${L.owner}, ${JSON.stringify({ toolsmithRequireApproval: on })}::jsonb)
             on conflict (user_id) do update
               set preferences = profiles.preferences || excluded.preferences`);
    const confirmOf = async (id: string) =>
      (
        await x<{ requires_confirm: boolean; description: string }>(sql`
        select requires_confirm, description from tools where id = ${id}`)
      )[0]!;

    it("the anchor's MCP client edits it at once: only in-brain agents wait", async () => {
      const { id, slug } = await insertHeld();
      const answer = await anchorMcp('api_tool_update', { slug, description: 'By MCP' });
      expect(answer).toMatch(/"updated":\s*true/);
      expect((await confirmOf(id)).description).toBe('By MCP');
    });

    it("the anchor's MCP client deletes it at once, and the name leaves the list", async () => {
      const { slug, group } = await insertHeld();
      const answer = await anchorMcp('api_tool_delete', { slug });
      expect(answer).toMatch(/"deleted":\s*true/);
      expect(await listOf(group)).not.toContain(slug);
    });

    it('with "require approval" on, an MCP client\'s edit turns the confirm back on; by hand it does not', async () => {
      await requireApproval(true);
      try {
        const viaMcp = await insertHeld();
        await anchorMcp('api_tool_update', { slug: viaMcp.slug, description: 'By MCP' });
        expect((await confirmOf(viaMcp.id)).requires_confirm).toBe(true);
        const byHand = await insertHeld();
        const res = await route(L.owner, 'PATCH', `/api/tools/${byHand.id}`, {
          description: 'By hand',
        });
        expect(res.status, res.text).toBe(200);
        expect(await confirmOf(byHand.id)).toEqual({
          requires_confirm: false,
          description: 'By hand',
        });
      } finally {
        await requireApproval(false);
      }
    });

    it('a person deleting it by hand takes the name out of the list too', async () => {
      const { id, slug, group } = await insertHeld();
      const res = await route(L.owner, 'DELETE', `/api/tools/${id}`);
      expect(res.status, res.text).toBe(200);
      expect(await listOf(group)).not.toContain(slug);
    });
  });

  describe('a tool the owner gated', () => {
    const insertTool = async (slug: string, enabled: boolean, requiresConfirm: boolean) => {
      const [row] = await x<{ id: string }>(sql`
        insert into tools (owner_id, slug, name, description, handler, enabled, requires_confirm)
        values (${L.owner}, ${slug}, 'n', 'd',
                ${JSON.stringify({ kind: 'http', url: 'https://api.example.test/x', method: 'GET' })}::jsonb,
                ${enabled}, ${requiresConfirm})
        returning id::text as id`);
      return row!.id;
    };
    const stateOf = async (id: string) =>
      (
        await x<{
          enabled: boolean;
          requires_confirm: boolean;
          on: boolean;
          via: string | null;
        }>(sql`
          select enabled, requires_confirm, external_access is not null as on,
                 external_access->'by'->>'via' as via
            from tools where id = ${id}`)
      )[0]!;

    it("the anchor's MCP client is refused each act, and may tighten", async () => {
      const slug = `pa_mcp_${randomUUID().slice(0, 8)}`;
      const id = await insertTool(slug, false, true);
      for (const args of [
        { requires_confirm: false },
        { enabled: true },
        { external_access: true, read_only_confirmed: true },
      ]) {
        const answer = await anchorMcp('api_tool_update', { slug, ...args });
        expect(answer).toMatch(/a person's act, not an agent's/);
        expect(answer).toMatch(/Settings > Tools/);
      }
      expect(await stateOf(id)).toMatchObject({
        enabled: false,
        requires_confirm: true,
        on: false,
      });

      const open = `pa_mcp_${randomUUID().slice(0, 8)}`;
      const openId = await insertTool(open, true, false);
      expect(await anchorMcp('api_tool_update', { slug: open, requires_confirm: true })).toMatch(
        /"updated":\s*true/,
      );
      expect(await anchorMcp('api_tool_update', { slug: open, enabled: false })).toMatch(
        /"updated":\s*true/,
      );
      expect(await stateOf(openId)).toMatchObject({ enabled: false, requires_confirm: true });
    });

    it("the anchor's MCP client acts at once on a group another workspace holds, which takes only what an agent may grant", async () => {
      const group = `pa_group_${randomUUID().slice(0, 8)}`;
      await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
                  values (${L.owner}, ${group}, 'g', '{}', true)`);
      await x(sql`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, workspace_id)
                  values (${L.owner}, ${`${group}-holder`}, 'h', 'm', 'p',
                          ${`{${group}}`}::text[], ${W})`);
      const http = `pa_mcp_${randomUUID().slice(0, 8)}`;
      await insertTool(http, true, false);
      const groupTools = async () =>
        (
          await x<{ tool_slugs: string[] }>(
            sql`select tool_slugs from tool_groups where owner_id = ${L.owner} and slug = ${group}`,
          )
        )[0]!.tool_slugs;

      expect(await anchorMcp('api_tool_update', { slug: http, group_slug: group })).toMatch(
        /"updated":\s*true/,
      );
      expect(await groupTools()).toEqual([http]);
      expect(await anchorMcp('api_tool_update', { slug: 'note_get', group_slug: group })).toMatch(
        /refused: note_get/,
      );
      expect(await groupTools()).toEqual([http]);
    });

    it('an Admin user does each in Settings', async () => {
      const id = await insertTool(`pa_web_${randomUUID().slice(0, 8)}`, false, true);
      const cleared = await route(L.owner, 'PATCH', `/api/tools/${id}`, {
        requiresConfirm: false,
        enabled: true,
      });
      expect(cleared.status, cleared.text).toBe(200);
      const on = await route(L.owner, 'PUT', `/api/tools/${id}/external-access`, {
        allow: true,
        readOnlyConfirmed: true,
      });
      expect(on.status, on.text).toBe(200);
      expect(await stateOf(id)).toEqual({
        enabled: true,
        requires_confirm: false,
        on: true,
        via: 'web',
      });
    });

    it('an Admin user does each in the dev tool console', async () => {
      const slug = `pa_dev_${randomUUID().slice(0, 8)}`;
      const id = await insertTool(slug, false, true);
      const run = (input: Record<string, unknown>) =>
        route(L.owner, 'POST', '/api/dev-tools/execute-tool', {
          slug: 'api_tool_update',
          input: { slug, ...input },
        });
      const cleared = await run({ requires_confirm: false, enabled: true });
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.json.ok, cleared.text).toBe(true);
      const on = await run({ external_access: true, read_only_confirmed: true });
      expect(on.json.ok, on.text).toBe(true);
      expect(await stateOf(id)).toEqual({
        enabled: true,
        requires_confirm: false,
        on: true,
        via: 'dev-tools',
      });
    });

    it('only a boolean changes a flag, in the console too', async () => {
      const slug = `pa_val_${randomUUID().slice(0, 8)}`;
      const id = await insertTool(slug, true, true);
      for (const requires_confirm of [0, 'no', {}, []]) {
        const res = await route(L.owner, 'POST', '/api/dev-tools/execute-tool', {
          slug: 'api_tool_update',
          input: { slug, requires_confirm },
        });
        expect(res.status, res.text).toBe(200);
      }
      expect(await stateOf(id)).toMatchObject({ requires_confirm: true });
    });

    it('a person approves a held call, it runs, and the switch says so', async () => {
      const slug = `pa_held_${randomUUID().slice(0, 8)}`;
      const id = await insertTool(slug, false, true);
      // Stamped as a turn of this login stamps it: an approval judges the call
      // again where it was asked.
      const surface = { kind: 'web', loginId: L.owner } as const;
      const origin = await m.withTurnScope(await m.loginScopeFor(L.owner), () =>
        t.pendingOriginNow(surface),
      );
      expect(origin.scope).toMatchObject({ loginId: L.owner });
      const held = await sys(() =>
        m.parkPendingCall({
          ownerId: L.owner,
          loginId: L.owner,
          toolSlug: 'api_tool_update',
          args: {
            slug,
            requires_confirm: false,
            enabled: true,
            external_access: true,
            read_only_confirmed: true,
          },
          origin,
        }),
      );
      const approved = await route(L.owner, 'PATCH', `/api/pending/${held}`, {
        decision: 'approve',
      });
      expect(approved.status, approved.text).toBe(200);
      expect(await stateOf(id), approved.text).toEqual({
        enabled: true,
        requires_confirm: false,
        on: true,
        via: 'pending',
      });
    });
  });

  describe('a history entry id that is not a uuid', () => {
    it.each([
      ['DELETE', (id: string) => `/api/tables/${id}/history/nope`],
      ['POST', (id: string) => `/api/tables/${id}/history/nope/restore`],
      ['GET', (id: string) => `/api/tables/${id}/history/nope/download`],
    ])('a table: %s answers 404', async (method, path) => {
      const made = await route(L.owner, 'POST', '/api/tables', { title: 'History' });
      expect(made.status, made.text).toBeLessThan(300);
      const id = String(made.json.table?.id ?? made.json.id);
      const res = await route(L.owner, method, path(id), method === 'POST' ? {} : undefined);
      expect(res.status, res.text).toBe(404);
    });

    it.each([
      ['DELETE', (id: string) => `/api/apps/${id}/snapshots/nope`],
      ['GET', (id: string) => `/api/apps/${id}/snapshots/nope/download`],
    ])('an app: %s answers 404', async (method, path) => {
      const app = await sys(() =>
        c.createApp(L.owner, { title: `app ${randomUUID().slice(0, 8)}` }),
      );
      const res = await route(L.owner, method, path(app.id));
      expect(res.status, res.text).toBe(404);
    });
  });
});

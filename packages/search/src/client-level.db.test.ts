/**
 * The client role reads CLIENT items only (client logins C1, migration 0187,
 * decision 3), on every search arm, against a real, migrated Postgres. One
 * item per level carries the same title words, tags, path, passage text and
 * embedding, so only the level decides what comes back. Also: items that are
 * not the brain's (a member's personal item, a team draft, an admin's
 * private item) never reach the client role even at level client; agents
 * and tool groups are filtered by level for the client role only; the client
 * role holds no grant on logins, yet the brain id still resolves. The team
 * and public roles are the controls.
 *
 * Seeds its own rows on the shared anchor and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/client-level.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const LEVELS = ['admin', 'team', 'client', 'public'] as const;
type Level = (typeof LEVELS)[number];

describe.skipIf(!URL)('the client role reads client items only, on every search arm', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  type Search = typeof import('./index');
  let m: Db;
  let s: Search;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `clientlvl${randomUUID().slice(0, 8)}`;
  const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  const vecLit = `[${vec.join(',')}]`;
  const item: Record<Level, string> = {
    admin: randomUUID(),
    team: randomUUID(),
    client: randomUUID(),
    public: randomUUID(),
  };
  const member = randomUUID();
  const adminLogin = randomUUID();
  const clientLogin = randomUUID();
  const notBrain = { memberItem: randomUUID(), teamDraft: randomUUID(), adminPrivate: randomUUID() };
  const agentSlug = (l: Level) => `${tag}-agent-${l}`;
  const groupSlug = (l: Level) => `${tag}-group-${l}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);

    for (const l of LEVELS) {
      await admin`insert into nodes (id, owner_id, type, title, path, audience, tags, embedding)
        values (${item[l]}, ${anchor}, 'page', ${`${tag} ${l} page`}, 'pages', ${l},
                ${[tag]}, ${vecLit}::vector)`;
      await admin`insert into pages (node_id, doc, doc_text)
        values (${item[l]}, '{"type":"doc","content":[]}'::jsonb, ${`${tag} body`})`;
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${anchor}, ${item[l]}, 0, ${`${tag} passage ${l}`}, ${vecLit}::vector)`;
      await admin`insert into facts (owner_id, content, source_node_id, embedding)
        values (${anchor}, ${`${tag} fact ${l}`}, ${item[l]}, ${vecLit}::vector)`;
      await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
        values (${anchor}, ${groupSlug(l)}, ${tag}, ${[]}, ${l})`;
      await admin`insert into agents (owner_id, slug, name, model, provider, system_prompt,
                                      tool_group_slugs, audience)
        values (${anchor}, ${agentSlug(l)}, ${tag}, 'fake/model', 'openrouter', 'x',
                ${[groupSlug(l)]}, ${l})`;
    }
    // A fact with no source: the owner's own chats, admin only.
    await admin`insert into facts (owner_id, content, embedding)
      values (${anchor}, ${`${tag} fact sourceless`}, ${vecLit}::vector)`;

    // Items that are not the brain's, each at client level: a member's
    // personal item, a member's team draft, an admin's private item. The
    // personal spaces come from the login trigger (0165).
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
      (${adminLogin}, ${`${tag}-a@example.invalid`}, 'x', 'admin'),
      (${clientLogin}, ${`${tag}-c@example.invalid`}, 'x', 'client')`;
    const space = async (login: string) =>
      (
        await admin<{ id: string }[]>`
          select id from spaces where kind = 'personal' and login_id = ${login}`
      )[0]!.id;
    const memberSpace = await space(member);
    const adminSpace = await space(adminLogin);
    await admin`insert into nodes (id, owner_id, type, title, path, audience, tags, embedding) values
      (${notBrain.memberItem}, ${memberSpace}, 'page', ${`${tag} member item`}, 'pages', 'client',
       ${[tag]}, ${vecLit}::vector),
      (${notBrain.teamDraft}, ${memberSpace}, 'page', ${`${tag} team draft`}, 'pages', 'client',
       ${[tag]}, ${vecLit}::vector),
      (${notBrain.adminPrivate}, ${adminSpace}, 'page', ${`${tag} admin private`}, 'pages', 'client',
       ${[tag]}, ${vecLit}::vector)`;
    await admin`insert into space_items (node_id, sharing) values (${notBrain.teamDraft}, 'team')
      on conflict (node_id) do update set sharing = 'team'`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from agents where slug like ${`${tag}-%`}`;
    await admin`delete from tool_groups where slug like ${`${tag}-%`}`;
    await admin`delete from facts where content like ${`${tag}%`}`;
    await admin`delete from nodes where title like ${`${tag}%`}`;
    await admin`delete from spaces where login_id in (${member}, ${adminLogin}, ${clientLogin})`;
    await admin`delete from auth.users where id in (${member}, ${adminLogin}, ${clientLogin})`;
    await m?.closeDb();
  });

  const ours = (ids: string[]) =>
    [...new Set(ids)].filter((id) => [...Object.values(item), ...Object.values(notBrain)].includes(id));
  const want = (levels: Level[]) => levels.map((l) => item[l]).sort();

  /** Every search arm at `level`: the ids of OUR items each returns. */
  async function arms(level: 'team' | 'client' | 'public') {
    return m.withViewer(level, async () => {
      const fts = await s.searchNodes({ ownerId: anchor, q: tag, limit: 50 });
      const hybrid = await s.searchNodes({ ownerId: anchor, q: tag, queryEmbedding: vec, limit: 50 });
      const vectorOnly = await s.searchNodes({ ownerId: anchor, queryEmbedding: vec, limit: 500 });
      const branchTags = await s.searchNodes({ ownerId: anchor, branch: 'pages', tags: [tag], limit: 50 });
      const chunksHybrid = await s.searchChunks({ ownerId: anchor, embedding: vec, q: tag, limit: 50 });
      const chunksVector = await s.searchChunks({ ownerId: anchor, embedding: vec, limit: 500 });
      const facts = (await m.db.execute(sqlTag`
        select f.source_node_id as id from facts f
          join nodes n on n.id = f.source_node_id
         where f.content like ${`${tag}%`}
         order by f.embedding <=> ${vecLit}::vector limit 50`)) as unknown as { id: string }[];
      const sourceless = (await m.db.execute(
        sqlTag`select id from facts where content = ${`${tag} fact sourceless`}`,
      )) as unknown as unknown[];
      const pages = (await m.db.execute(
        sqlTag`select node_id as id from pages where doc_text = ${`${tag} body`}`,
      )) as unknown as { id: string }[];
      const byId = (await m.db.execute(
        sqlTag`select id from nodes where id in ${sqlTag.raw(
          `(${[...Object.values(item), ...Object.values(notBrain)].map((i) => `'${i}'`).join(',')})`,
        )}`,
      )) as unknown as { id: string }[];
      return {
        fts: ours(fts.map((r) => r.id)),
        hybrid: ours(hybrid.map((r) => r.id)),
        vectorOnly: ours(vectorOnly.map((r) => r.id)),
        branchTags: ours(branchTags.map((r) => r.id)),
        chunksHybrid: ours(chunksHybrid.map((r) => r.nodeId)),
        chunksVector: ours(chunksVector.map((r) => r.nodeId)),
        facts: ours(facts.map((r) => r.id)),
        sourceless: sourceless.length,
        pages: ours(pages.map((r) => r.id)),
        byId: ours(byId.map((r) => r.id)),
      };
    });
  }

  it('the rows are all there on the admin pool', async () => {
    const [r] = await admin<{ n: number }[]>`
      select count(*)::int as n from nodes where title like ${`${tag}%`}`;
    expect(r!.n).toBe(7);
  });

  it('client: every arm returns the client item and nothing else', async () => {
    const got = await arms('client');
    for (const [arm, ids] of Object.entries(got)) {
      if (arm === 'sourceless') continue;
      expect([...(ids as string[])].sort(), arm).toEqual(want(['client']));
    }
    expect(got.sourceless, 'a sourceless fact').toBe(0);
  });

  it('team (control): team, client and public, never admin or anyone else', async () => {
    const got = await arms('team');
    for (const [arm, ids] of Object.entries(got)) {
      if (arm === 'sourceless') continue;
      expect([...(ids as string[])].sort(), arm).toEqual(want(['team', 'client', 'public']));
    }
    expect(got.sourceless).toBe(0);
  });

  it('public (control): public only', async () => {
    const got = await arms('public');
    for (const [arm, ids] of Object.entries(got)) {
      if (arm === 'sourceless') continue;
      expect([...(ids as string[])].sort(), arm).toEqual(want(['public']));
    }
  });

  it('agents and tool groups: the client role reads client and public ones only', async () => {
    const read = (level: 'team' | 'client' | 'public') =>
      m.withViewer(level, async () => ({
        agents: (
          (await m.db.execute(
            sqlTag`select slug from agents where slug like ${`${tag}-%`} order by slug`,
          )) as unknown as { slug: string }[]
        ).map((r) => r.slug),
        groups: (
          (await m.db.execute(
            sqlTag`select slug from tool_groups where slug like ${`${tag}-%`} order by slug`,
          )) as unknown as { slug: string }[]
        ).map((r) => r.slug),
      }));
    const client = await read('client');
    expect(client.agents).toEqual([agentSlug('client'), agentSlug('public')].sort());
    expect(client.groups).toEqual([groupSlug('client'), groupSlug('public')].sort());
    // The team role keeps every row: a team agent may delegate to an admin one.
    const team = await read('team');
    expect(team.agents).toEqual(LEVELS.map(agentSlug).sort());
    expect(team.groups).toEqual(LEVELS.map(groupSlug).sort());
    const pub = await read('public');
    expect(pub.agents).toEqual(LEVELS.map(agentSlug).sort());
  });

  it('logins: no grant for the client role, the brain id still resolves', async () => {
    await expect(
      m.withViewer('client', () => m.db.execute(sqlTag`select id from auth.users limit 1`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const [brain] = (await m.withViewer('client', () =>
      m.db.execute(sqlTag`select mantle_brain_id() as id`),
    )) as unknown as { id: string }[];
    expect(brain!.id).toBe(anchor);
    // The team role still reads the columns the matrix names.
    const rows = (await m.withViewer('team', () =>
      m.db.execute(sqlTag`select id, is_owner from auth.users where id = ${anchor}`),
    )) as unknown as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('a client login is never a member: its space is no member space (Team drafts)', async () => {
    const [r] = await admin<{ member: boolean; client: boolean }[]>`
      select mantle_member_space((select id from spaces where kind = 'personal' and login_id = ${member})) as member,
             mantle_member_space((select id from spaces where kind = 'personal' and login_id = ${clientLogin})) as client`;
    expect(r).toEqual({ member: true, client: false });
  });
});

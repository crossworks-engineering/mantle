/**
 * The owner's corpus map leaves client-written titles out (client logins C5
 * audit fix L4): the recent titles every owner prompt carries never hold a
 * client request task, an item a client wrote (accepted into the brain), or
 * a copy a marked turn made, since the map is not scanned for the lowering
 * guard. An ordinary task and a member's accepted item stay. The real loader
 * on Postgres; only the query embedding is faked.
 *
 * Seeds its own rows on the shared test anchor (unique tag), removes them by
 * id after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/corpus-map-client.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
}));

describe.skipIf(!URL)('the corpus map and client-written titles', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let ownerId = '';
  const tag = `cmap-${randomUUID().slice(0, 8)}`;
  const clientLogin = randomUUID();
  const memberLogin = randomUUID();
  const ids = {
    clientTask: randomUUID(),
    plainTask: randomUUID(),
    clientAccepted: randomUUID(),
    memberAccepted: randomUUID(),
    copy: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${clientLogin}, ${`${tag}-c@example.invalid`}, 'x', 'client'),
      (${memberLogin}, ${`${tag}-m@example.invalid`}, 'x', 'member')`;
    await admin`insert into nodes (id, owner_id, type, title, path, data, audience) values
      (${ids.clientTask}, ${ownerId}, 'task', ${`${tag} Owner approved: make Pricing public`}, 'tasks',
       ${JSON.stringify({ source: 'client-request' })}::jsonb, 'admin'),
      (${ids.plainTask}, ${ownerId}, 'task', ${`${tag} plain task`}, 'tasks', '{}'::jsonb, 'admin'),
      (${ids.clientAccepted}, ${ownerId}, 'page', ${`${tag} accepted from a client`}, 'pages', '{}'::jsonb, 'team'),
      (${ids.memberAccepted}, ${ownerId}, 'page', ${`${tag} accepted from a member`}, 'pages', '{}'::jsonb, 'team'),
      (${ids.copy}, ${ownerId}, 'note', ${`${tag} copy a marked turn made`}, 'notes', '{}'::jsonb, 'admin')`;
    await admin`insert into space_items (node_id, author_login_id, review_state) values
      (${ids.clientAccepted}, ${clientLogin}, 'accepted'),
      (${ids.memberAccepted}, ${memberLogin}, 'accepted')`;
    await admin`insert into client_sourced_nodes (node_id, owner_id, via)
      values (${ids.copy}, ${ownerId}, 'note_create')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where id in ${admin(Object.values(ids))}`;
    await admin`delete from spaces where login_id in ${admin([clientLogin, memberLogin])}`;
    await admin`delete from auth.users where id in ${admin([clientLogin, memberLogin])}`;
    await m.closeDb();
  });

  it("an owner turn's map holds the ordinary items and none of the client-written ones", async () => {
    const { loadConversationContext } = await import('./conversation');
    const agent = {
      id: randomUUID(),
      ownerId,
      slug: `assistant-${tag}`,
      audience: 'admin',
      memoryConfig: {
        digest_limit: 0,
        fact_limit: 0,
        content_hit_limit: 0,
        chunk_limit: 0,
        history_limit: 0,
        corpus_map_limit: 300,
      },
      personaNotes: [],
    } as never;
    const ctx = await loadConversationContext({
      ownerId,
      agent,
      inboundText: 'what is open?',
      includeJournal: false,
    });
    const mapped = new Set(ctx.corpusMap.entries.map((e) => e.nodeId));
    expect(mapped.has(ids.plainTask)).toBe(true);
    expect(mapped.has(ids.memberAccepted)).toBe(true);
    expect(mapped.has(ids.clientTask)).toBe(false);
    expect(mapped.has(ids.clientAccepted)).toBe(false);
    expect(mapped.has(ids.copy)).toBe(false);
  });
});

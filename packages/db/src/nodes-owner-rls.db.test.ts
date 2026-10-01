/**
 * The brain-owner check in the nodes read rule (migration 0159,
 * `nodes_viewer_read`: owner_id = mantle_brain_id()), tested directly on a
 * real, migrated Postgres. A node at the team level that the brain does NOT
 * own (a member's personal item, or another brain-kind space) is invisible
 * to the level roles, however it got there: here it is written on the admin
 * pool, past every write rule. Without the owner check, a member's
 * personal item at 'team' would show in every team-level read.
 * Seeds its own logins and rows, removes them (the shared anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/nodes-owner-rls.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('nodes read rule: only the brain owner’s items reach a level role', () => {
  type Db = typeof import('./index');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `owner-rls-${randomUUID().slice(0, 8)}`;
  const member = randomUUID();
  const otherBrain = randomUUID();
  let anchor: string;
  let personal: string;
  const ids = {
    brainTeam: randomUUID(),
    brainPublic: randomUUID(),
    brainClient: randomUUID(),
    personalTeam: randomUUID(),
    personalPublic: randomUUID(),
    otherBrainTeam: randomUUID(),
  };

  const visibleAt = async (level: 'team' | 'client' | 'public') =>
    (
      (await m.withViewer(level, () =>
        m.db.execute(sqlTag`select id from nodes where title like ${`${tag}%`}`),
      )) as unknown as { id: string }[]
    )
      .map((r) => r.id)
      .sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);

    await admin`insert into auth.users (id, email, password_hash, role) values
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
      (${otherBrain}, ${`${tag}-b@example.invalid`}, 'x', 'admin')`;
    // A brain-kind space that is not the brain (as a test's own brain is).
    await admin`insert into spaces (id, kind, login_id) values (${otherBrain}, 'brain', ${otherBrain})`;
    const [p] = await admin<{ id: string }[]>`
      select id from spaces where kind = 'personal' and login_id = ${member}`;
    personal = p!.id;

    // All written on the admin pool: no write rule stands in the way.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.brainTeam}, ${anchor}, 'page', ${`${tag} brain team`}, 'pages', 'team'),
      (${ids.brainPublic}, ${anchor}, 'note', ${`${tag} brain public`}, 'notes', 'public'),
      (${ids.brainClient}, ${anchor}, 'note', ${`${tag} brain client`}, 'notes', 'client'),
      (${ids.personalTeam}, ${personal}, 'page', ${`${tag} personal team`}, 'pages', 'team'),
      (${ids.personalPublic}, ${personal}, 'note', ${`${tag} personal public`}, 'notes', 'public'),
      (${ids.otherBrainTeam}, ${otherBrain}, 'page', ${`${tag} other brain`}, 'pages', 'team')`;
  });

  afterAll(async () => {
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await admin`delete from nodes where title like ${`${tag}%`}`;
    await admin`delete from spaces where login_id in (${member}, ${otherBrain})`;
    await admin`delete from auth.users where id in (${member}, ${otherBrain})`;
    await m.closeDb();
  });

  it('the admin pool sees every row (the rows are there)', async () => {
    const rows = (await m.systemDb.execute(
      sqlTag`select id from nodes where title like ${`${tag}%`}`,
    )) as unknown as { id: string }[];
    expect(rows).toHaveLength(6);
  });

  it('the team role sees the brain’s items only, never another owner’s at the same level', async () => {
    expect(await visibleAt('team')).toEqual(
      [ids.brainTeam, ids.brainPublic, ids.brainClient].sort(),
    );
  });

  it('the client and public roles likewise, each at its own level only', async () => {
    // Client logins C1 (0187): the client role reads client items, not public.
    expect(await visibleAt('client')).toEqual([ids.brainClient]);
    expect(await visibleAt('public')).toEqual([ids.brainPublic]);
  });

  it('asked for by id, a non-brain item still reads as nothing', async () => {
    const rows = (await m.withViewer('team', () =>
      m.db.execute(
        sqlTag`select id from nodes where id in (${ids.personalTeam}, ${ids.otherBrainTeam})`,
      ),
    )) as unknown as { id: string }[];
    expect(rows).toEqual([]);
  });
});

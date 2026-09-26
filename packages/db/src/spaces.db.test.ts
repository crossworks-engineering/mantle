/**
 * Personal spaces on a real, MIGRATED Postgres (member logins Phase 2,
 * migration 0165): the space role sees and writes only the space its
 * transaction names, a submitted item is frozen, other members' team-shared
 * items are visible only to a human request at the team level, and the brain
 * never announces a personal item. Seeds its own logins and rows, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/spaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const INSUFFICIENT_PRIVILEGE = '42501';

/** The SQLSTATE of a failed drizzle query (it wraps the driver error). */
function codeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

describe.skipIf(!URL)('personal spaces under row level security', () => {
  type Db = typeof import('./index');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor: string;
  let createdAnchor = false;
  const tag = `spaces-${randomUUID().slice(0, 8)}`;
  const loginA = randomUUID();
  const loginB = randomUUID();
  let spaceA: string;
  let spaceB: string;
  const ids = {
    aPrivate: randomUUID(),
    bPrivate: randomUUID(),
    bTeam: randomUUID(),
    brainTeam: randomUUID(),
  };

  const rows = async <T>(q: ReturnType<typeof sqlTag>) => (await m.db.execute(q)) as unknown as T[];
  const titles = async () =>
    (
      await rows<{ title: string }>(
        sqlTag`select title from nodes where title like ${`${tag}%`} order by title`,
      )
    ).map((r) => r.title.slice(tag.length + 1));
  const asA = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: spaceA, loginId: loginA }, fn);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    // Grants come from migrate (applyViewerGrants); re-applying them here would
    // race the access-matrix test's own reset (tuple concurrently updated).

    const owner = (await m.systemDb.execute(
      sqlTag`select id from auth.users where is_owner limit 1`,
    )) as unknown as { id: string }[];
    if (owner[0]) {
      anchor = owner[0].id;
    } else {
      anchor = randomUUID();
      createdAnchor = true;
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, is_owner)
        values (${anchor}, ${`${tag}-owner@example.invalid`}, 'x', true)`);
    }
    // Two member logins: the trigger gives each a personal space.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${loginA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
        (${loginB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`);
    const spaces = (await m.systemDb.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${loginA}, ${loginB})`)) as unknown as {
      id: string;
      login_id: string;
    }[];
    spaceA = spaces.find((s) => s.login_id === loginA)!.id;
    spaceB = spaces.find((s) => s.login_id === loginB)!.id;

    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${ids.aPrivate}, ${spaceA}, 'page', ${`${tag} a-private`}, 'pages', 'admin'),
        (${ids.bPrivate}, ${spaceB}, 'page', ${`${tag} b-private`}, 'pages', 'admin'),
        (${ids.bTeam}, ${spaceB}, 'page', ${`${tag} b-team`}, 'pages', 'admin'),
        (${ids.brainTeam}, ${anchor}, 'page', ${`${tag} brain-team`}, 'pages', 'team')`);
    await m.systemDb.execute(sqlTag`
      insert into pages (node_id, doc, doc_text, draft_doc) values
        (${ids.aPrivate}, '{"type":"doc"}'::jsonb, 'a', '{"type":"doc","draft":1}'::jsonb),
        (${ids.bTeam}, '{"type":"doc"}'::jsonb, 'b', '{"type":"doc","draft":1}'::jsonb)`);
    await m.systemDb.execute(sqlTag`
      insert into space_items (node_id, author_login_id, sharing) values
        (${ids.aPrivate}, ${loginA}, 'private'),
        (${ids.bPrivate}, ${loginB}, 'private'),
        (${ids.bTeam}, ${loginB}, 'team')`);
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where title like ${`${tag}%`}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${loginA}, ${loginB})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${loginA}, ${loginB})`);
    if (createdAnchor) {
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    }
    await m.closeDb();
  });

  it('a new login gets exactly one personal space; the anchor also owns the brain row', async () => {
    const r = (await m.systemDb.execute(sqlTag`
      select kind, count(*)::int as n from spaces where login_id = ${loginA} group by kind`)) as unknown as {
      kind: string;
      n: number;
    }[];
    expect(r).toEqual([{ kind: 'personal', n: 1 }]);
    const brain = (await m.systemDb.execute(
      sqlTag`select kind from spaces where id = ${anchor}`,
    )) as unknown as { kind: string }[];
    expect(brain[0]?.kind).toBe('brain');
  });

  it('the space role sees its own space only: not another member, not the brain', async () => {
    expect(await asA(titles)).toEqual(['a-private']);
    const page = await asA(() =>
      rows<{ draft_doc: unknown }>(
        sqlTag`select draft_doc from pages where node_id = ${ids.aPrivate}`,
      ),
    );
    // The member's own draft is readable (their working copy).
    expect(page[0]?.draft_doc).toEqual({ type: 'doc', draft: 1 });
  });

  it('the space scope runs at team, so it cannot queue work', async () => {
    await asA(async () => {
      expect(m.currentViewerLevel()).toBe('team');
      expect(m.currentSpaceScope()?.spaceId).toBe(spaceA);
    });
  });

  it('writes land in the own space only', async () => {
    const mine = randomUUID();
    await asA(() =>
      m.db.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
        values (${mine}, ${spaceA}, 'note', ${`${tag} a-note`}, 'notes')`),
    );
    expect(await asA(titles)).toEqual(['a-note', 'a-private']);

    // Into another member's space, into the brain, a non-workspace kind, a
    // level: every one refused by the row rule.
    for (const [owner, type, audience] of [
      [spaceB, 'note', 'admin'],
      [anchor, 'note', 'admin'],
      [spaceA, 'task', 'admin'],
      [spaceA, 'note', 'team'],
    ] as const) {
      const err = await asA(() =>
        m.db.execute(sqlTag`insert into nodes (owner_id, type, title, path, audience)
          values (${owner}, ${type}, ${`${tag} refused`}, 'notes', ${audience})`),
      ).catch((e: unknown) => e);
      expect(codeOf(err), `${owner === anchor ? 'brain' : owner} ${type} ${audience}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
    // Updating another member's row matches nothing.
    await asA(() => m.db.execute(sqlTag`update nodes set title = 'x' where id = ${ids.bPrivate}`));
    const b = (await m.systemDb.execute(
      sqlTag`select title from nodes where id = ${ids.bPrivate}`,
    )) as unknown as { title: string }[];
    expect(b[0]?.title).toBe(`${tag} b-private`);
  });

  it('with no space set, the space role sees nothing and writes nothing', async () => {
    const res = await m.withViewer('team', async () => {
      // Not a space scope: the team pool. The space role itself is only ever
      // reached through withSpace, so prove the policy with an empty setting.
      return m.withSpace({ spaceId: randomUUID(), loginId: loginA }, titles);
    });
    expect(res).toEqual([]);
  });

  it('a submitted item is frozen: no edit, no delete; Recall unfreezes it', async () => {
    await asA(() =>
      m.db.execute(sqlTag`update space_items set review_state = 'submitted', submitted_at = now()
        where node_id = ${ids.aPrivate}`),
    );
    await asA(async () => {
      await m.db.execute(sqlTag`update nodes set title = 'edited' where id = ${ids.aPrivate}`);
      await m.db.execute(
        sqlTag`update pages set doc_text = 'edited' where node_id = ${ids.aPrivate}`,
      );
      await m.db.execute(sqlTag`delete from nodes where id = ${ids.aPrivate}`);
    });
    const frozen = (await m.systemDb.execute(sqlTag`
      select n.title, p.doc_text from nodes n join pages p on p.node_id = n.id
      where n.id = ${ids.aPrivate}`)) as unknown as { title: string; doc_text: string }[];
    expect(frozen[0]).toEqual({ title: `${tag} a-private`, doc_text: 'a' });

    // The member can never accept their own item.
    const err = await asA(() =>
      m.db.execute(sqlTag`update space_items set review_state = 'accepted'
        where node_id = ${ids.aPrivate}`),
    ).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(INSUFFICIENT_PRIVILEGE);

    // Recall: back to draft, editable again.
    await asA(() =>
      m.db.execute(sqlTag`update space_items set review_state = 'draft', submitted_at = null
        where node_id = ${ids.aPrivate}`),
    );
    await asA(() =>
      m.db.execute(sqlTag`update pages set doc_text = 'edited' where node_id = ${ids.aPrivate}`),
    );
    const after = (await m.systemDb.execute(
      sqlTag`select doc_text from pages where node_id = ${ids.aPrivate}`,
    )) as unknown as { doc_text: string }[];
    expect(after[0]?.doc_text).toBe('edited');
  });

  it('team drafts: a human request at team sees team-shared items, published columns only', async () => {
    const seen = await m.withTeamDrafts(titles);
    expect(seen).toContain('b-team');
    expect(seen).toContain('brain-team');
    expect(seen).not.toContain('b-private');
    expect(seen).not.toContain('a-private');

    const doc = await m.withTeamDrafts(() =>
      rows<{ doc_text: string }>(sqlTag`select doc_text from pages where node_id = ${ids.bTeam}`),
    );
    expect(doc[0]?.doc_text).toBe('b');
    const draft = await m
      .withTeamDrafts(() =>
        m.db.execute(sqlTag`select draft_doc from pages where node_id = ${ids.bTeam}`),
      )
      .catch((e: unknown) => e);
    expect(codeOf(draft)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('an agent at team (no human flag) and a client viewer never see anyone’s drafts', async () => {
    expect(await m.withViewer('team', titles)).toEqual(['brain-team']);
    expect(await m.withViewer('client', titles)).toEqual([]);
  });

  it('the brain never announces a personal item to the extractor', async () => {
    const r = (await m.systemDb.execute(sqlTag`
      select mantle_is_brain_space(${anchor}::uuid) as brain,
             mantle_is_brain_space(${spaceA}::uuid) as personal`)) as unknown as {
      brain: boolean;
      personal: boolean;
    }[];
    expect(r[0]).toEqual({ brain: true, personal: false });
  });

  it('deleting a login leaves its space and items behind', async () => {
    const gone = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${gone}, ${`${tag}-gone@example.invalid`}, 'x', 'member')`);
    const [space] = (await m.systemDb.execute(
      sqlTag`select id from spaces where login_id = ${gone}`,
    )) as unknown as { id: string }[];
    await m.systemDb.execute(sqlTag`
      insert into nodes (owner_id, type, title, path) values (${space!.id}, 'note', ${`${tag} orphan`}, 'notes')`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${gone}`);
    const left = (await m.systemDb.execute(sqlTag`
      select s.login_id, count(n.id)::int as n from spaces s join nodes n on n.owner_id = s.id
      where s.id = ${space!.id} group by s.login_id`)) as unknown as {
      login_id: string | null;
      n: number;
    }[];
    expect(left).toEqual([{ login_id: null, n: 1 }]);
    await m.systemDb.execute(sqlTag`delete from spaces where id = ${space!.id}`);
    const cascaded = (await m.systemDb.execute(
      sqlTag`select count(*)::int as n from nodes where title = ${`${tag} orphan`}`,
    )) as unknown as { n: number }[];
    expect(cascaded[0]?.n).toBe(0);
  });
});

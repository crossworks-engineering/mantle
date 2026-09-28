/**
 * Levels drive links, against a real, migrated Postgres: setting a level
 * fixes the item's link, and every older share path (create, mode, revoke,
 * sub-page cascade) re-derives the level from the link it leaves. Team links
 * are retired (member logins Phase 6 stage 6): team takes no link, and no
 * path makes one. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shares-levels.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('levels drive links on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  type Shares = typeof import('./shares');
  let m: Db;
  let a: Access;
  let s: Shares;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = {
    note: randomUUID(),
    page: randomUUID(),
    parent: randomUUID(),
    sub: randomUUID(),
    task: randomUUID(),
    embed: randomUUID(),
    team: randomUUID(),
    teamParent: randomUUID(),
    teamSub: randomUUID(),
    // Client logins C1: client items with and without an old live link.
    cNote: randomUUID(),
    cOld: randomUUID(),
    cParent: randomUUID(),
    cSub: randomUUID(),
    cEmbed: randomUUID(),
  };
  const tag = `share-levels-${owner.slice(0, 8)}`;

  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    s = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.embed, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    // Items belong to a space (0165): this test's own owner is a brain row.
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id) values
        (${ids.note}, ${owner}, 'note', 'n', 'notes', null),
        (${ids.page}, ${owner}, 'page', 'p', 'pages', null),
        (${ids.parent}, ${owner}, 'page', 'parent', 'pages', null),
        (${ids.sub}, ${owner}, 'page', 'sub', 'pages', ${ids.parent}),
        (${ids.task}, ${owner}, 'task', 't', 'tasks', null),
        (${ids.embed}, ${owner}, 'file', 'img.png', 'files', null),
        (${ids.team}, ${owner}, 'note', 'team note', 'notes', null),
        (${ids.teamParent}, ${owner}, 'page', 'team parent', 'pages', null),
        (${ids.teamSub}, ${owner}, 'page', 'team sub', 'pages', ${ids.teamParent}),
        (${ids.cNote}, ${owner}, 'note', 'client note', 'notes', null),
        (${ids.cOld}, ${owner}, 'page', 'client old link', 'pages', null),
        (${ids.cParent}, ${owner}, 'page', 'client parent', 'pages', null),
        (${ids.cSub}, ${owner}, 'page', 'client sub', 'pages', ${ids.cParent}),
        (${ids.cEmbed}, ${owner}, 'file', 'c.png', 'files', null)`);
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${ids.page}, ${JSON.stringify(doc)}::jsonb, ''),
        (${ids.parent}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.sub}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.teamParent}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.teamSub}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.cOld}, ${JSON.stringify({
          type: 'doc',
          content: [{ type: 'image', attrs: { nodeId: ids.cEmbed, src: 'x' } }],
        })}::jsonb, ''),
        (${ids.cParent}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.cSub}, '{"type":"doc","content":[]}'::jsonb, '')`);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('team and client take no link (and drop an open one), public an open one, admin none', async () => {
    const team = await a.setItemLevel(owner, ids.note, 'team');
    expect(team.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.note)).toBeNull();
    expect(await audienceOf(ids.note)).toBe('team');

    const open = await a.setItemLevel(owner, ids.note, 'public');
    expect(open.share?.mode).toBe('public');
    expect(await audienceOf(ids.note)).toBe('public');

    // Client (client logins C1): signed-in clients, no link. The open link goes.
    const client = await a.setItemLevel(owner, ids.note, 'client');
    expect(client.share).toBeNull();
    expect(await s.resolveActiveShareByToken(open.share!.token)).toBeNull();
    expect(await audienceOf(ids.note)).toBe('client');

    // Back to team: no link, the item stays at team.
    const back = await a.setItemLevel(owner, ids.note, 'team');
    expect(back.share).toBeNull();
    expect(await audienceOf(ids.note)).toBe('team');

    const admin = await a.setItemLevel(owner, ids.note, 'admin');
    expect(admin.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.note)).toBeNull();
    expect(await audienceOf(ids.note)).toBe('admin');
  });

  it('gives closure items the level but no link of their own', async () => {
    const res = await a.setItemLevel(owner, ids.page, 'team', { withClosure: true });
    expect(res.lowered.map((i) => i.id)).toEqual([ids.embed]);
    expect(await audienceOf(ids.embed)).toBe('team');
    expect(await s.getActiveShareForNode(owner, ids.embed)).toBeNull();
    await a.setItemLevel(owner, ids.page, 'admin');
    // Raising never raises the closure.
    expect(await audienceOf(ids.embed)).toBe('team');
  });

  it('re-derives the level on the older share paths, and refuses a team link', async () => {
    const link = await s.createShare(owner, ids.note);
    expect(link.mode).toBe('public');
    expect(await audienceOf(ids.note)).toBe('public');
    expect(await s.applyShareMode(owner, link.id, 'public')).toBe(true);
    expect(await audienceOf(ids.note)).toBe('public');

    // An untyped caller asking for team: refused, nothing written.
    const team = 'team' as never;
    await expect(s.applyShareMode(owner, link.id, team)).rejects.toBeInstanceOf(
      s.TeamLinkRetiredError,
    );
    await expect(s.createShare(owner, ids.page, { mode: team })).rejects.toBeInstanceOf(
      s.TeamLinkRetiredError,
    );
    expect(await s.getActiveShareForNode(owner, ids.page)).toBeNull();
    const [row] = (await m.db.execute(
      sqlTag`select settings from shares where id = ${link.id}`,
    )) as unknown as { settings: Record<string, unknown> }[];
    expect(row!.settings.mode).toBeUndefined();
    expect(await audienceOf(ids.note)).toBe('public');

    await s.revokeShareTree(owner, link.id);
    expect(await audienceOf(ids.note)).toBe('admin');
  });

  it("puts cascaded sub-pages at the parent's level, to team and to admin with it", async () => {
    await a.setItemLevel(owner, ids.parent, 'public');
    await s.setShareCascade(owner, ids.parent, true);
    expect(await audienceOf(ids.sub)).toBe('public');
    expect(await s.getActiveShareForNode(owner, ids.sub)).not.toBeNull();

    // Parent to team: its link and the sub-page links go, the sub-page follows.
    await a.setItemLevel(owner, ids.parent, 'team');
    expect(await s.getActiveShareForNode(owner, ids.parent)).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.sub)).toBeNull();
    expect(await audienceOf(ids.sub)).toBe('team');

    await a.setItemLevel(owner, ids.parent, 'public');
    await s.setShareCascade(owner, ids.parent, true);
    expect(await audienceOf(ids.sub)).toBe('public');
    await a.setItemLevel(owner, ids.parent, 'admin');
    expect(await audienceOf(ids.sub)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.sub)).toBeNull();
  });

  it('removing an open link puts the item at admin; a team item has no link to remove', async () => {
    await a.setItemLevel(owner, ids.team, 'team');
    expect(await s.getActiveShareForNode(owner, ids.team)).toBeNull();

    const open = await a.setItemLevel(owner, ids.team, 'public');
    const gone = await a.unshareItem(owner, open.share!.id);
    expect(gone).toEqual({ revoked: true, stillBelow: [] });
    expect(await audienceOf(ids.team)).toBe('admin');
  });

  it('a team parent has no link to cascade', async () => {
    await a.setItemLevel(owner, ids.teamParent, 'team');
    expect(await s.setShareCascade(owner, ids.teamParent, true)).toEqual({ ok: false, count: 0 });
    expect(await audienceOf(ids.teamSub)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.teamSub)).toBeNull();
  });

  it('keeps a task admin whatever its link, and admin removes an old link', async () => {
    await s.createShare(owner, ids.task);
    expect(await audienceOf(ids.task)).toBe('admin');
    const res = await a.setItemLevel(owner, ids.task, 'admin');
    expect(res.share).toBeNull();
    expect(await s.getActiveShareForNode(owner, ids.task)).toBeNull();
    await expect(a.setItemLevel(owner, ids.task, 'team')).rejects.toMatchObject({
      code: 'type_ceiling',
    });
  });
  // ── Client logins C1: no new client link, no flip (plan section 10.1) ────
  describe('client items', () => {
    /** A link made before C1, when client meant an open link: written as the
     *  old code left it, a live share on an item at client. */
    const oldLink = async (nodeId: string, settings: Record<string, unknown> = {}) => {
      await m.db.execute(sqlTag`
        update shares set revoked_at = now() where node_id = ${nodeId} and revoked_at is null`);
      const [row] = (await m.db.execute(sqlTag`
        insert into shares (owner_id, node_id, node_type, token, settings)
        select ${owner}, id, type, ${`old-${randomUUID()}`}, ${JSON.stringify(settings)}::jsonb
          from nodes where id = ${nodeId}
        returning id, token`)) as unknown as { id: string; token: string }[];
      await m.db.execute(sqlTag`update nodes set audience = 'client' where id = ${nodeId}`);
      return row!;
    };

    it('every link-making path refuses a client item and makes no link', async () => {
      await a.setItemLevel(owner, ids.cNote, 'client');
      // node_share, page_share, POST /api/shares and the email link all call
      // createShare; the Access control and access_set call setItemLevel.
      await expect(s.createShare(owner, ids.cNote)).rejects.toBeInstanceOf(
        s.ClientLinkRetiredError,
      );
      await expect(s.createShare(owner, ids.cNote)).rejects.toMatchObject({
        reason: 'client-links-retired',
      });
      // A sub-page asked to follow a client parent is refused the same way.
      await expect(s.createShare(owner, ids.note, { preferred: 'client' })).rejects.toBeInstanceOf(
        s.ClientLinkRetiredError,
      );
      const set = await a.setItemLevel(owner, ids.cNote, 'client');
      expect(set.share).toBeNull();
      expect(await s.getActiveShareForNode(owner, ids.cNote)).toBeNull();
      expect(await audienceOf(ids.cNote)).toBe('client');
    });

    it('an old live link is not handed out again', async () => {
      const old = await oldLink(ids.cOld);
      await expect(s.createShare(owner, ids.cOld)).rejects.toBeInstanceOf(s.ClientLinkRetiredError);
      // The old link itself is untouched until C3 retires it.
      expect(await s.resolveActiveShareByToken(old.token)).not.toBeNull();
      expect(await audienceOf(ids.cOld)).toBe('client');
    });

    it('a client item with an old live link stays client after every re-sync', async () => {
      const old = await oldLink(ids.cOld);
      await m.db.execute(sqlTag`update nodes set audience = 'admin' where id = ${ids.cEmbed}`);
      expect(await s.applyShareMode(owner, old.id, 'public')).toBe(true);
      expect(await audienceOf(ids.cOld)).toBe('client');
      // Its embed was not pulled to public (or anywhere) by the re-sync.
      expect(await audienceOf(ids.cEmbed)).toBe('admin');
      // Revoking the old link keeps the level: client is not a link.
      await s.revokeShareTree(owner, old.id);
      expect(await audienceOf(ids.cOld)).toBe('client');
    });

    it('unsharing an old client link keeps the item at client', async () => {
      const old = await oldLink(ids.cOld);
      const res = await a.unshareItem(owner, old.id);
      expect(res).toEqual({ revoked: true, stillBelow: [] });
      expect(await s.resolveActiveShareByToken(old.token)).toBeNull();
      expect(await audienceOf(ids.cOld)).toBe('client');
    });

    it('an old cascading client parent shares no sub-page, and its re-syncs move nothing', async () => {
      const old = await oldLink(ids.cParent, { cascade: true });
      await m.db.execute(sqlTag`update nodes set audience = 'client' where id = ${ids.cSub}`);
      await expect(s.setShareCascade(owner, ids.cParent, true)).rejects.toBeInstanceOf(
        s.ClientLinkRetiredError,
      );
      expect(await s.getActiveShareForNode(owner, ids.cSub)).toBeNull();
      expect(await s.applyShareMode(owner, old.id, 'public')).toBe(true);
      expect(await audienceOf(ids.cParent)).toBe('client');
      expect(await audienceOf(ids.cSub)).toBe('client');
      // Cascade off: nothing moves either.
      expect(await s.setShareCascade(owner, ids.cParent, false)).toMatchObject({ ok: true });
      expect(await audienceOf(ids.cParent)).toBe('client');
      expect(await audienceOf(ids.cSub)).toBe('client');
      await s.revokeShareTree(owner, old.id);
      expect(await audienceOf(ids.cParent)).toBe('client');
      expect(await audienceOf(ids.cSub)).toBe('client');
    });

    it('setting public still makes an open link, and client again removes it', async () => {
      const pub = await a.setItemLevel(owner, ids.cNote, 'public');
      expect(pub.share?.mode).toBe('public');
      const back = await a.setItemLevel(owner, ids.cNote, 'client');
      expect(back.share).toBeNull();
      expect(await s.resolveActiveShareByToken(pub.share!.token)).toBeNull();
      expect(await audienceOf(ids.cNote)).toBe('client');
    });
  });
});

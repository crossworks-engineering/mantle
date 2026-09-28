/**
 * Levels and links, the edges (against a real, migrated Postgres):
 *  - unsharing an item applies the admin closure rule: what it embeds is
 *    reported in `stillBelow`, never raised on its own (MED 7);
 *  - an expired but unrevoked link does not block a new one (the one-link
 *    index is WHERE revoked_at IS NULL);
 *  - `setItemLevel` writes level and link as one: a link that fails leaves
 *    the level where it was;
 *  - a cascaded sub-page never passes through a level below its parent's.
 * Seeds its own owner, rows and test triggers and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shares-closure.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('levels and links at the edges on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  type Shares = typeof import('./shares');
  let m: Db;
  let a: Access;
  let s: Shares;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = {
    page: randomUUID(),
    file: randomUUID(),
    note: randomUUID(),
    refused: randomUUID(),
    parent: randomUUID(),
    sub: randomUUID(),
    teamSub: randomUUID(),
  };
  const tag = `share-closure-${owner.slice(0, 8)}`;
  // Identifiers for this run's test triggers (hex only: safe to inline).
  const suffix = owner.replace(/-/g, '').slice(0, 12);
  const log = `test_audience_log_${suffix}`;

  const run = (text: string) => m.db.execute(sqlTag.raw(text));
  const audienceOf = async (id: string) =>
    (
      (await m.db.execute(sqlTag`select audience from nodes where id = ${id}`)) as unknown as {
        audience: string;
      }[]
    )[0]!.audience;
  const liveLinks = async (id: string) =>
    (await m.db.execute(
      sqlTag`select id, expires_at from shares where node_id = ${id} and revoked_at is null`,
    )) as unknown as { id: string; expires_at: string | null }[];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    s = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    const doc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: ids.file, src: 'x' } }],
    };
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id) values
        (${ids.page}, ${owner}, 'page', 'A page', 'pages', null),
        (${ids.file}, ${owner}, 'file', 'img.png', 'files', null),
        (${ids.note}, ${owner}, 'note', 'n', 'notes', null),
        (${ids.refused}, ${owner}, 'note', 'refused', 'notes', null),
        (${ids.parent}, ${owner}, 'page', 'parent', 'pages', null),
        (${ids.sub}, ${owner}, 'page', 'sub', 'pages', ${ids.parent}),
        (${ids.teamSub}, ${owner}, 'page', 'team sub', 'pages', ${ids.parent})`);
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${ids.page}, ${JSON.stringify(doc)}::jsonb, ''),
        (${ids.parent}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.sub}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${ids.teamSub}, '{"type":"doc","content":[]}'::jsonb, '')`);
  });

  afterAll(async () => {
    await run(`drop trigger if exists ${log}_trg on nodes`);
    await run(`drop function if exists ${log}_fn()`);
    await run(`drop table if exists ${log}`);
    await run(`drop trigger if exists test_refuse_${suffix}_trg on shares`);
    await run(`drop function if exists test_refuse_${suffix}_fn()`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('unsharing reports the embedded file still below admin, and raises nothing', async () => {
    await a.setItemLevel(owner, ids.page, 'client', { withClosure: true });
    expect(await audienceOf(ids.file)).toBe('client');
    const link = (await s.getActiveShareForNode(owner, ids.page))!;

    const res = await a.unshareItem(owner, link.id);
    expect(res.revoked).toBe(true);
    expect(res.stillBelow.map((i) => [i.id, i.audience])).toEqual([[ids.file, 'client']]);
    expect(await audienceOf(ids.page)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.page)).toBeNull();
    // Same rule as setting admin by hand: reported, never raised on its own.
    expect(await audienceOf(ids.file)).toBe('client');

    // A second unshare of the same link is a no-op, not an error.
    expect(await a.unshareItem(owner, link.id)).toEqual({ revoked: false, stillBelow: [] });
  });

  it('an expired, unrevoked link does not block setting the level (LOW)', async () => {
    const old = await s.createShare(owner, ids.note);
    await m.db.execute(
      sqlTag`update shares set expires_at = now() - interval '1 day' where id = ${old.id}`,
    );
    expect(await s.getActiveShareForNode(owner, ids.note)).toBeNull();

    const res = await a.setItemLevel(owner, ids.note, 'client');
    expect(res.share).not.toBeNull();
    expect(res.share!.id).not.toBe(old.id);
    const live = await liveLinks(ids.note);
    expect(live.map((l) => l.id)).toEqual([res.share!.id]);
    expect(live[0]!.expires_at).toBeNull();
    expect(await audienceOf(ids.note)).toBe('client');
  });

  it('a link that cannot be made leaves the level where it was (one transaction)', async () => {
    await run(`
      create function test_refuse_${suffix}_fn() returns trigger language plpgsql as $$
      begin
        if new.node_id = '${ids.refused}' then raise exception 'test: link refused'; end if;
        return new;
      end $$`);
    await run(`
      create trigger test_refuse_${suffix}_trg before insert on shares
        for each row execute function test_refuse_${suffix}_fn()`);
    try {
      await expect(a.setItemLevel(owner, ids.refused, 'client')).rejects.toThrow();
      expect(await audienceOf(ids.refused)).toBe('admin');
    } finally {
      await run(`drop trigger if exists test_refuse_${suffix}_trg on shares`);
      await run(`drop function if exists test_refuse_${suffix}_fn()`);
    }
  });

  it('a cascaded sub-page goes straight to the parent level, never through public', async () => {
    // The team sub-page has a team-only link of its own: the cascade re-modes it.
    await a.setItemLevel(owner, ids.teamSub, 'team');
    await a.setItemLevel(owner, ids.parent, 'client');
    await run(`create table ${log} (node_id uuid, audience text, at serial)`);
    await run(`
      create function ${log}_fn() returns trigger language plpgsql as $$
      begin
        insert into ${log} (node_id, audience) values (new.id, new.audience);
        return new;
      end $$`);
    await run(`
      create trigger ${log}_trg after update of audience on nodes for each row
        when (new.owner_id = '${owner}') execute function ${log}_fn()`);
    try {
      const res = await s.setShareCascade(owner, ids.parent, true);
      expect(res).toEqual({ ok: true, count: 2 });
      const seen = (await run(`select node_id, audience from ${log} order by at`)) as unknown as {
        node_id: string;
        audience: string;
      }[];
      const levelsOf = (id: string) => seen.filter((r) => r.node_id === id).map((r) => r.audience);
      expect(levelsOf(ids.sub)).toEqual(['client']);
      expect(levelsOf(ids.teamSub)).toEqual(['client']);
      expect(await audienceOf(ids.sub)).toBe('client');
      expect(await audienceOf(ids.teamSub)).toBe('client');
    } finally {
      await run(`drop trigger if exists ${log}_trg on nodes`);
      await run(`drop function if exists ${log}_fn()`);
      await run(`drop table if exists ${log}`);
    }
  });
});

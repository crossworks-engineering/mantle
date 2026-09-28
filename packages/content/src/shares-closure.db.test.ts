/**
 * Levels and links, the edges (against a real, migrated Postgres):
 *  - unsharing an item applies the admin closure rule: what it embeds is
 *    reported in `stillBelow`, never raised on its own (MED 7);
 *  - an expired but unrevoked link does not block a new one (the one-link
 *    index is WHERE revoked_at IS NULL);
 *  - `setItemLevel` writes level and link as one: a link that fails leaves
 *    the level where it was;
 *  - a cascaded sub-page never passes through a level below its parent's.
 * The pool is real; a thin wrapper around it records the levels written to
 * nodes and can refuse one link's insert (no DDL on shared tables: other DB
 * test files run beside this one). Seeds its own owner and rows and removes
 * them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/shares-closure.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** Levels written to nodes, while recording. */
  audiences: null as string[] | null,
  /** A node whose link insert fails, when set. */
  refuseLinkFor: null as string | null,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  type Fn = (...args: unknown[]) => unknown;
  type Builder = Record<string, Fn>;
  // Wraps the pool and every transaction (nested ones too) the same way.
  const watch = <T extends object>(q: T): T =>
    new Proxy(q, {
      get(target, p) {
        const v = Reflect.get(target, p) as unknown;
        if (typeof v !== 'function') return v;
        const fn = (v as Fn).bind(target);
        if (p === 'transaction') {
          return (cb: (tx: object) => unknown, ...rest: unknown[]) =>
            fn((tx: object) => cb(watch(tx)), ...rest);
        }
        if (p === 'update') {
          return (table: unknown) => {
            const b = fn(table) as Builder;
            if (table !== actual.nodes || !h.audiences) return b;
            const set = b.set!.bind(b);
            b.set = (vals) => {
              const audience = (vals as { audience?: string }).audience;
              if (audience) h.audiences?.push(audience);
              return set(vals);
            };
            return b;
          };
        }
        if (p === 'insert') {
          return (table: unknown) => {
            const b = fn(table) as Builder;
            if (table !== actual.shares || !h.refuseLinkFor) return b;
            const values = b.values!.bind(b);
            b.values = (vals) => {
              if ((vals as { nodeId?: string }).nodeId === h.refuseLinkFor) {
                throw new Error('test: link refused');
              }
              return values(vals);
            };
            return b;
          };
        }
        return fn;
      },
    });
  return { ...actual, db: watch(actual.db) };
});

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
    h.audiences = null;
    h.refuseLinkFor = null;
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('unsharing reports the embedded file still below admin, and raises nothing', async () => {
    await a.setItemLevel(owner, ids.page, 'public', { withClosure: true });
    expect(await audienceOf(ids.file)).toBe('public');
    const link = (await s.getActiveShareForNode(owner, ids.page))!;

    const res = await a.unshareItem(owner, link.id);
    expect(res.revoked).toBe(true);
    expect(res.stillBelow.map((i) => [i.id, i.audience])).toEqual([[ids.file, 'public']]);
    expect(await audienceOf(ids.page)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.page)).toBeNull();
    // Same rule as setting admin by hand: reported, never raised on its own.
    expect(await audienceOf(ids.file)).toBe('public');

    // A second unshare of the same link is a no-op, not an error.
    expect(await a.unshareItem(owner, link.id)).toEqual({ revoked: false, stillBelow: [] });
  });

  it('an expired, unrevoked link does not block setting the level (LOW)', async () => {
    const old = await s.createShare(owner, ids.note);
    await m.db.execute(
      sqlTag`update shares set expires_at = now() - interval '1 day' where id = ${old.id}`,
    );
    expect(await s.getActiveShareForNode(owner, ids.note)).toBeNull();

    const res = await a.setItemLevel(owner, ids.note, 'public');
    expect(res.share).not.toBeNull();
    expect(res.share!.id).not.toBe(old.id);
    const live = await liveLinks(ids.note);
    expect(live.map((l) => l.id)).toEqual([res.share!.id]);
    expect(live[0]!.expires_at).toBeNull();
    expect(await audienceOf(ids.note)).toBe('public');
  });

  it('a link that cannot be made leaves the level where it was (one transaction)', async () => {
    h.refuseLinkFor = ids.refused;
    try {
      await expect(a.setItemLevel(owner, ids.refused, 'public')).rejects.toThrow(
        /test: link refused/,
      );
    } finally {
      h.refuseLinkFor = null;
    }
    expect(await audienceOf(ids.refused)).toBe('admin');
    expect(await s.getActiveShareForNode(owner, ids.refused)).toBeNull();
  });

  it('a cascaded sub-page goes straight to the parent level, never through public', async () => {
    // The team sub-page has a team-only link of its own: the cascade re-modes it.
    await a.setItemLevel(owner, ids.teamSub, 'team');
    await a.setItemLevel(owner, ids.parent, 'public');
    h.audiences = [];
    let written: string[];
    try {
      const res = await s.setShareCascade(owner, ids.parent, true);
      expect(res).toEqual({ ok: true, count: 2 });
    } finally {
      written = h.audiences;
      h.audiences = null;
    }
    // One write per sub-page, straight to public: the new link on `sub`, the
    // re-moded one on `teamSub`. (Before client logins C1 this was a client parent.)
    expect(written).toEqual(['public', 'public']);
    expect(await audienceOf(ids.sub)).toBe('public');
    expect(await audienceOf(ids.teamSub)).toBe('public');
  });
});

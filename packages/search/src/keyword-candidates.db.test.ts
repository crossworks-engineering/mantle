/**
 * The keyword arm of a hybrid node search in a big workspace scope, with
 * the runtime role on (MANTLE_DB_RUNTIME_ROLE=1: the system pool logs in as
 * mantle_runtime): the ranked text match runs on the narrow route for ids
 * only ('keyword-candidates'), and the scope keeps the ids it reads.
 *
 *  - the items the scope reads are found by their words alone (they hold
 *    no embedding, so only the keyword arm can return them);
 *  - an item of another workspace that holds the same words, more often
 *    (it ranks first among the keyword candidates), is not, and takes no
 *    place of the scope's: with the limit at the scope's own count, all of
 *    them come back (a candidate kept past the scope's re-read would push
 *    one out, though the final read drops it);
 *  - the candidates went through the narrow route, with no denial.
 *
 * Seeds its own rows on the shared anchor and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/keyword-candidates.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
/** MANTLE_DB_RUNTIME_ROLE as the run set it, back after this file. */
const RUNTIME_SWITCH = process.env.MANTLE_DB_RUNTIME_ROLE;

describe.skipIf(!URL)('keyword candidates of a big scope, on the runtime role', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let s: typeof import('./index');
  let ts: typeof import('@mantle/db/test-support');
  let su: ReturnType<typeof import('@mantle/db/test-support').superuserClient>;
  let anchor = '';
  const word = `kwc${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const login = randomUUID();
  const ws = { team: randomUUID(), other: randomUUID() };
  const inTeam = [randomUUID(), randomUUID(), randomUUID()];
  const outside = randomUUID();
  const items = [...inTeam, outside];
  const query = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_DB_RUNTIME_ROLE = '1';
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    ts = await import('@mantle/db/test-support');
    m = await import('@mantle/db');
    s = await import('./index');
    su = ts.superuserClient(URL!, 1);
    anchor = await ts.ensureTestAnchor(su);
    await su`insert into auth.users (id, email, password_hash, role)
             values (${login}, ${`${word}@example.invalid`}, 'x', 'member')`;
    await su`insert into workspaces (id, owner_id, name) values
             (${ws.team}, ${anchor}, ${`${word} team`}), (${ws.other}, ${anchor}, ${`${word} other`})`;
    for (const [k, id] of items.entries()) {
      // The outside item names the word three times: it ranks first.
      const title = id === outside ? `${word} ${word} ${word} note` : `${word} note ${k}`;
      await su`insert into nodes (id, owner_id, type, title, path)
               values (${id}, ${anchor}, 'page', ${title}, 'pages')`;
    }
    for (const id of inTeam) {
      await su`insert into item_grants (node_id, workspace_id) values (${id}, ${ws.team})`;
    }
    await su`insert into item_grants (node_id, workspace_id) values (${outside}, ${ws.other})`;
  }, 60_000);

  afterAll(async () => {
    delete process.env.MANTLE_SCOPE_EXACT_MAX_ROWS;
    if (su) {
      await su`delete from item_grants where node_id = any(${`{${items.join(',')}}`}::uuid[])`;
      await su`delete from nodes where id = any(${`{${items.join(',')}}`}::uuid[])`;
      await su`delete from workspaces where id in (${ws.team}, ${ws.other})`;
      await su`delete from spaces where login_id = ${login}`;
      await su`delete from auth.users where id = ${login}`;
      await su.end();
    }
    await m?.closeDb();
    if (RUNTIME_SWITCH === undefined) delete process.env.MANTLE_DB_RUNTIME_ROLE;
    else process.env.MANTLE_DB_RUNTIME_ROLE = RUNTIME_SWITCH;
  });

  it("finds the scope's items by their words through the narrow route, and no other workspace's", async () => {
    // No scope searches exactly: every workspace scope is a big one here.
    process.env.MANTLE_SCOPE_EXACT_MAX_ROWS = '0';
    const search = (limit: number) =>
      s.searchNodes({ ownerId: anchor, q: word, queryEmbedding: query, ids: items, limit });
    // Unscoped, the outside item is a keyword candidate, and the first.
    const all = await m.asSystem(() => search(10), 'test');
    expect(all.map((n) => n.id)[0]).toBe(outside);
    expect(all.map((n) => n.id).sort()).toEqual([...items].sort());
    ts.takeNarrowUses();
    const { big, hits, read } = await m.withScope(
      { kind: 'user', loginId: login, ws: [ws.team], modWs: [] },
      async () => ({
        big: !(await s.smallScope('nodes')),
        hits: await search(inTeam.length),
        read: await m.db
          .select({ id: m.nodes.id })
          .from(m.nodes)
          .where(m.sql`${m.nodes.id} = ${outside}`),
      }),
    );
    expect(big).toBe(true);
    // Not in the scope's rows, so it takes no place of the scope's items.
    expect(read).toEqual([]);
    expect(hits.map((n) => n.id).sort()).toEqual([...inTeam].sort());
    expect(ts.takeNarrowUses()['system:keyword-candidates']).toBeGreaterThan(0);
    expect(ts.takeNarrowDenials()).toEqual([]);
  });
});

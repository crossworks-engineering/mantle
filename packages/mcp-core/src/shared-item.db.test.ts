/**
 * othersCanRead on a real, migrated Postgres: an admin page shared with a
 * contact counts as read by others (access matrix T3), so a key or a peer
 * cannot change what it embeds. A revoked or expired contact share, and an
 * admin page with no share, do not count.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/mcp-core/src/shared-item.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('othersCanRead and contact shares', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shared: typeof import('./shared-item');
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const tag = `osr-${randomUUID().slice(0, 8)}`;
  const contact = randomUUID();
  const page = randomUUID();
  const q = (s: ReturnType<typeof sqlTag>) => m.systemDb.execute(s);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    shared = await import('./shared-item');
    sqlTag = (await import('drizzle-orm')).sql;
    await q(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await q(sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    await q(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${contact}, ${anchor}, 'contact', ${`${tag} contact`}, 'contacts', 'admin'),
        (${page}, ${anchor}, 'page', ${`${tag} page`}, 'pages', 'admin')`);
  }, 60_000);

  afterAll(async () => {
    await q(sqlTag`delete from shares where owner_id = ${anchor}`);
    await q(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await q(sqlTag`delete from spaces where login_id = ${anchor}`);
    await q(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  /** The one contact share of the page (one per item and contact), set
   *  live, revoked or expired. */
  const share = async (state: 'live' | 'revoked' | 'expired') => {
    await q(sqlTag`delete from shares where owner_id = ${anchor}`);
    await q(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, contact_id, revoked_at, expires_at)
      values (${anchor}, ${page}, 'page', ${`${tag}-${randomUUID()}`}, ${contact},
        ${state === 'revoked' ? sqlTag`now()` : null},
        ${state === 'expired' ? sqlTag`now() - interval '1 day'` : null})`);
  };

  it('an admin page with no share is read by admins only', async () => {
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
  });

  it('a revoked or expired contact share does not count', async () => {
    await share('revoked');
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
    await share('expired');
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
  });

  it('a live contact share counts: the contact reads what the page embeds', async () => {
    await share('live');
    expect(await shared.othersCanRead(anchor, page)).toBe(true);
  });
});

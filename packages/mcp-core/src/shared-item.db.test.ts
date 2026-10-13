/**
 * othersCanRead on a real, migrated Postgres (workspaces W5b2, from the
 * grants): a page a workspace other than Admin holds counts as read by
 * others, and so does one with a live link, open or for a contact (access
 * matrix T3), so a key or a peer cannot change what it embeds. A revoked or
 * expired link, a page only Admin holds, and a page whose level alone says
 * team do not count.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/mcp-core/src/shared-item.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('othersCanRead from the grants and live links', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shared: typeof import('./shared-item');
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const tag = `osr-${randomUUID().slice(0, 8)}`;
  const contact = randomUUID();
  const page = randomUUID();
  const teamPage = randomUUID();
  const levelPage = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID() };
  const q = (s: ReturnType<typeof sqlTag>) => m.systemDb.execute(s);
  const grant = (node: string, wsId: string, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, is_home)
        values (${node}, ${wsId}, ${home})`),
    );

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
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null)`);
    await q(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${contact}, ${anchor}, 'contact', ${`${tag} contact`}, 'contacts', 'admin'),
        (${page}, ${anchor}, 'page', ${`${tag} page`}, 'pages', 'admin'),
        (${teamPage}, ${anchor}, 'page', ${`${tag} team page`}, 'pages', 'admin'),
        (${levelPage}, ${anchor}, 'page', ${`${tag} level page`}, 'pages', 'team')`);
    for (const id of [page, teamPage, levelPage]) await grant(id, ws.admin, true);
    await grant(teamPage, ws.team);
  }, 60_000);

  afterAll(async () => {
    await q(sqlTag`delete from shares where owner_id = ${anchor}`);
    await q(sqlTag`delete from item_grants where node_id in (${page}, ${teamPage}, ${levelPage})`);
    await q(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await q(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await q(sqlTag`delete from spaces where login_id = ${anchor}`);
    await q(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  /** The one link of the page, for a contact or open, set live, revoked or
   *  expired. */
  const share = async (state: 'live' | 'revoked' | 'expired', forContact = true) => {
    await q(sqlTag`delete from shares where owner_id = ${anchor}`);
    await q(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, contact_id, revoked_at, expires_at)
      values (${anchor}, ${page}, 'page', ${`${tag}-${randomUUID()}`},
        ${forContact ? contact : null},
        ${state === 'revoked' ? sqlTag`now()` : null},
        ${state === 'expired' ? sqlTag`now() - interval '1 day'` : null})`);
  };

  it('a page only Admin holds, with no link, is read by admins only', async () => {
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
  });

  it('a page another workspace holds counts; a level alone does not', async () => {
    expect(await shared.othersCanRead(anchor, teamPage)).toBe(true);
    expect(await shared.othersCanRead(anchor, levelPage)).toBe(false);
  });

  it('a revoked or expired link does not count', async () => {
    await share('revoked');
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
    await share('expired', false);
    expect(await shared.othersCanRead(anchor, page)).toBe(false);
  });

  it('a live contact share or open link counts: they read what the page embeds', async () => {
    await share('live');
    expect(await shared.othersCanRead(anchor, page)).toBe(true);
    await share('live', false);
    expect(await shared.othersCanRead(anchor, page)).toBe(true);
  });
});

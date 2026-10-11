/**
 * A CLIENT login's personal space (client logins C1, plan section 3.4 and
 * test 6: "nothing pulled down to client by accident"), on a real, migrated
 * Postgres. No client login can be made through the API before C2 and no
 * client can submit before C5; these rows are written by hand to pin the
 * rules the later phases build on:
 *
 *  - withSpace runs a client's space at level client (a member's at team),
 *    so everything inside reads the brain as a client does;
 *  - the save-time embed rule reads as the author (W5b2: the author's
 *    workspaces): a client draft may name its own items and items its
 *    client workspace holds, never an item only Team holds;
 *
 * Accept, Take over and Give back were removed with the rest of review in
 * workspaces W5c.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()); the
 * workspaces (the client's, and a team one with the member in it) are this
 * test's own. Removes its rows after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a client login’s space: its level and embeds', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cspace-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const client = randomUUID();
  const member = randomUUID();
  const adminA = randomUUID();
  const logins = [client, member, adminA];
  const spaceOf: Record<string, string> = {};
  const brainItems = { team: randomUUID(), client: randomUUID(), pub: randomUUID() };
  // The client's workspace (the client item), and a team one the member is
  // in (the team and client items); the public note no workspace holds.
  const ws = { client: randomUUID(), team: randomUUID() };
  const created: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-cspace-'));

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const mention = (id: string) => ({
    type: 'paragraph',
    content: [{ type: 'mention', attrs: { id, ref: 'node' } }],
  });
  const say = (text: string, extra: unknown[] = []) => ({
    type: 'doc',
    content: [...extra, { type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  /** A saved page in `login`'s space naming `refs`. */
  const page = async (login: string, title: string, refs: string[] = []) => {
    const S = spaceOf[login]!;
    const id = (await as(login, () => sp.createMineItem(S, { type: 'page', title }))).id;
    created.push(id);
    const res = await as(login, () => sp.saveMinePage(S, id, say(title, refs.map(mention))));
    expect(res.ok, `save ${title}`).toBe(true);
    return id;
  };
  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Cleo Client'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', null),
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', null)`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${client}, ${member}, ${adminA})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${brainItems.team}, ${brain}, 'note', ${`${tag} team note`}, 'notes', 'team'),
        (${brainItems.client}, ${brain}, 'note', ${`${tag} client note`}, 'notes', 'client'),
        (${brainItems.pub}, ${brain}, 'note', ${`${tag} public note`}, 'notes', 'public')`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${ws.client}, ${brain}, ${`${tag} client`}), (${ws.team}, ${brain}, ${`${tag} team`})`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values
        (${ws.client}, ${client}), (${ws.team}, ${member})`);
    await m.withHeads([brainItems.team, brainItems.client], 'update', async (tx) => {
      await tx.execute(sqlTag`
        insert into item_grants (node_id, workspace_id) values
          (${brainItems.client}, ${ws.client}), (${brainItems.client}, ${ws.team}),
          (${brainItems.team}, ${ws.team})`);
    });
  }, 60_000);

  afterAll(async () => {
    for (const id of [...created, ...Object.values(brainItems)]) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await m.systemDb.execute(sqlTag`delete from workspaces where id in (${ws.client}, ${ws.team})`);
    for (const l of logins) {
      await m.systemDb.execute(sqlTag`delete from nodes where owner_id in
        (select id from spaces where login_id = ${l})`);
      await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${l}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${l}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('every login got its personal space (the 0165 trigger), the client too', () => {
    expect(Object.keys(spaceOf).sort()).toEqual([...logins].sort());
  });

  it('withSpace runs a client’s space at client, a member’s and an admin’s at team', async () => {
    expect(await as(client, async () => m.currentViewerLevel())).toBe('client');
    expect(await as(member, async () => m.currentViewerLevel())).toBe('team');
    expect(await as(adminA, async () => m.currentViewerLevel())).toBe('team');
    // Inside a client's space the brain reads as a client: a nested team
    // read goes no higher.
    const seen = await as(client, () =>
      m.runInLevelRoleForTest('team', async () =>
        (
          (await m.db.execute(
            sqlTag`select id from nodes where id in (${brainItems.team}, ${brainItems.client}, ${brainItems.pub})`,
          )) as unknown as { id: string }[]
        ).map((r) => r.id),
      ),
    );
    expect(seen).toEqual([brainItems.client]);
  });

  it('withSpace refuses a login that does not exist', async () => {
    await expect(
      m.withSpace({ spaceId: spaceOf[client]!, loginId: randomUUID() }, async () => 1),
    ).rejects.toThrow(/no such login/);
  });

  it('the embed rule reads as the author: a client may not name an item only Team holds', async () => {
    const C = spaceOf[client]!;
    const id = (await as(client, () => sp.createMineItem(C, { type: 'page', title: `${tag} c` })))
      .id;
    created.push(id);
    const refused = as(client, () => sp.saveMinePage(C, id, say('x', [mention(brainItems.team)])));
    await expect(refused).rejects.toMatchObject({ reason: 'embed', ids: [brainItems.team] });
    // In a client's words: a client has no Library (audit U6).
    await expect(refused).rejects.toThrow(
      'This page uses items you cannot share: only your own items and items shared with you.',
    );
    // Nor an item only an open link reads (decision 3).
    await expect(
      as(client, () => sp.saveMinePage(C, id, say('x', [mention(brainItems.pub)]))),
    ).rejects.toMatchObject({ reason: 'embed', ids: [brainItems.pub] });
    const ok = await as(client, () =>
      sp.saveMinePage(C, id, say('x', [mention(brainItems.client)])),
    );
    expect(ok.ok).toBe(true);
    // The member (control) may name the team item.
    const mid = await page(member, `${tag} m`, [brainItems.team]);
    // A member's refusal still names the Library: the client's page is not theirs.
    await expect(
      as(member, () => sp.saveMinePage(spaceOf[member]!, mid, say('x', [mention(id)]))),
    ).rejects.toThrow('only your own items and Library items.');
  });
});

/**
 * A CLIENT login's personal space (client logins C1, plan section 3.4 and
 * test 6: "nothing pulled down to client by accident"), on a real, migrated
 * Postgres. No client login can be made through the API before C2 and no
 * client can submit before C5; these rows are written by hand to pin the
 * rules the later phases build on:
 *
 *  - withSpace runs a client's space at level client (a member's at team),
 *    so everything inside reads the brain as a client does;
 *  - the save-time embed rule reads at the author's level: a client draft
 *    may name its own items and client items, never a team item;
 *  - Accept of a client-authored item defaults to team, and client or
 *    public needs an explicit confirmation (a member's item keeps admin);
 *  - give back after Take over checks the item at the author's level:
 *    refused while it names a team item, allowed with a client item.
 *
 * Brain items belong to the shared test anchor (mantle_brain_id()): the
 * level reads go through row security, which knows only that brain. Removes
 * its rows after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-space.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a client login’s space: its level, embeds, Accept and give back', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let rv: typeof import('./member-review');
  let tk: typeof import('./member-takeover');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cspace-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const client = randomUUID();
  const member = randomUUID();
  const adminA = randomUUID();
  const logins = [client, member, adminA];
  const spaceOf: Record<string, string> = {};
  const brainItems = { team: randomUUID(), client: randomUUID(), pub: randomUUID() };
  const created: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-cspace-'));

  const as = <T>(login: string, fn: () => Promise<T>) =>
    m.withSpace({ spaceId: spaceOf[login]!, loginId: login }, fn);
  const exec = async <T>(q: ReturnType<typeof sqlTag>) =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const audienceOf = async (id: string) =>
    (await exec<{ audience: string }>(sqlTag`select audience from nodes where id = ${id}`))[0]
      ?.audience;
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
  const submitted = async (login: string, title: string, refs: string[] = []) => {
    const id = await page(login, title, refs);
    await as(login, () => sp.submitItem(spaceOf[login]!, id));
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
    rv = await import('./member-review');
    tk = await import('./member-takeover');
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
  });

  afterAll(async () => {
    for (const id of [...created, ...Object.values(brainItems)]) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
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
      m.withViewer('team', async () =>
        (
          (await m.db.execute(
            sqlTag`select id from nodes where id in (${brainItems.team}, ${brainItems.client}, ${brainItems.pub})`,
          )) as unknown as { id: string }[]
        ).map((r) => r.id),
      ),
    );
    expect(seen).toEqual([brainItems.client]);
  });

  it('withSpace refuses a login with a role it does not know', async () => {
    await expect(
      m.withSpace({ spaceId: spaceOf[client]!, loginId: randomUUID() }, async () => 1),
    ).rejects.toThrow(/no personal space level/);
  });

  it('the embed rule reads at the author’s level: a client may not name a team item', async () => {
    const C = spaceOf[client]!;
    const id = (await as(client, () => sp.createMineItem(C, { type: 'page', title: `${tag} c` })))
      .id;
    created.push(id);
    await expect(
      as(client, () => sp.saveMinePage(C, id, say('x', [mention(brainItems.team)]))),
    ).rejects.toMatchObject({ reason: 'embed', ids: [brainItems.team] });
    // A public item is not a client item either (decision 3).
    await expect(
      as(client, () => sp.saveMinePage(C, id, say('x', [mention(brainItems.pub)]))),
    ).rejects.toMatchObject({ reason: 'embed', ids: [brainItems.pub] });
    const ok = await as(client, () =>
      sp.saveMinePage(C, id, say('x', [mention(brainItems.client)])),
    );
    expect(ok.ok).toBe(true);
    // The member (control) may name the team item.
    await page(member, `${tag} m`, [brainItems.team]);
  });

  it('Accept of a client’s item defaults to team; client needs a confirmation', async () => {
    const reviewer = { loginId: adminA };
    const first = await submitted(client, `${tag} request 1`, [brainItems.client]);
    const res = await rv.acceptReviewItem(brain, first, reviewer);
    expect(res.audience).toBe('team');
    expect(await audienceOf(first)).toBe('team');

    const second = await submitted(client, `${tag} request 2`);
    for (const audience of ['client', 'public'] as const) {
      await expect(rv.acceptReviewItem(brain, second, reviewer, { audience })).rejects.toMatchObject(
        { reason: 'confirm-level' },
      );
    }
    expect(await audienceOf(second)).toBe('admin'); // still the client's, untouched
    const confirmed = await rv.acceptReviewItem(brain, second, reviewer, {
      audience: 'client',
      lowerConfirmed: true,
    });
    expect(confirmed.audience).toBe('client');
    expect(await audienceOf(second)).toBe('client');

    // A member's item (control): admin by default, as before.
    const third = await submitted(member, `${tag} member request`);
    expect((await rv.acceptReviewItem(brain, third, reviewer)).audience).toBe('admin');
  });

  it('acceptAudience: the rule by role, with no database', () => {
    expect(rv.acceptAudience('member', {})).toBe('admin');
    expect(rv.acceptAudience(null, {})).toBe('admin');
    expect(rv.acceptAudience('client', {})).toBe('team');
    expect(rv.acceptAudience('client', { audience: 'admin' })).toBe('admin');
    expect(() => rv.acceptAudience('client', { audience: 'client' })).toThrow(/client wrote/);
    expect(rv.acceptAudience('client', { audience: 'public', lowerConfirmed: true })).toBe('public');
    expect(rv.acceptAudience('member', { audience: 'client' })).toBe('client');
  });

  it('give back after Take over checks the item at the author’s level (client)', async () => {
    const id = await submitted(client, `${tag} to take`);
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    await rv.takeOverReviewItem(id, actor);
    const from = await tk.takenFromOf(actor.spaceId, [id]);
    expect(from.get(id)).toMatchObject({ loginId: client, name: 'Cleo Client', canGiveBack: true });

    // The admin names a TEAM item while it is theirs: a member could take
    // that back, a client may not.
    const A = actor.spaceId;
    const writer = { adminOfBrain: brain };
    expect(
      (
        await as(adminA, () =>
          sp.saveMinePage(A, id, say('admin', [mention(brainItems.team)]), writer),
        )
      ).ok,
    ).toBe(true);
    await expect(tk.giveBackTakenItem(brain, actor, id, 'Fix it')).rejects.toMatchObject({
      reason: 'embed',
      ids: [brainItems.team],
    });
    // With a client item instead, it goes back to the client.
    expect(
      (
        await as(adminA, () =>
          sp.saveMinePage(A, id, say('admin', [mention(brainItems.client)]), writer),
        )
      ).ok,
    ).toBe(true);
    const back = await tk.giveBackTakenItem(brain, actor, id, 'Fix it');
    expect(back.returned.map((b) => b.id)).toEqual([id]);
    const [row] = await exec<{ owner_id: string }>(
      sqlTag`select owner_id from nodes where id = ${id}`,
    );
    expect(row?.owner_id).toBe(spaceOf[client]);
  });
});

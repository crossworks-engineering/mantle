/**
 * Contact shares on a real, migrated Postgres (migration 0214; docs/
 * sharing.md, "Contact shares"). Seeds its own brain and removes it.
 *
 * Data: two contacts and the open link live side by side on one item; a
 * second live share for the same contact is refused; a folder is refused;
 * deleting the contact removes its shares and its code row; switch off then
 * Enable never revives an old cookie (the epoch only goes up) and starts
 * with no shares; the CHECK refuses can_write on a page and the trigger a
 * share to a node that is not a contact; share_access_log is reaped at 90
 * days.
 *
 * Levels: a level change to admin, team, client or public never revokes a
 * contact share; removing a contact share changes no level; the open-link
 * paths (node_share's createShare, the unshare paths) make and revoke only
 * the open link; a contact-shared admin app is in no member or client
 * launcher.
 *
 * Codes: a right code opens; the per-share limit (10 an hour) and the
 * per-contact lock (30 a day) hold, counted in the database (a "restart",
 * fresh module state, changes nothing); regenerate clears the lock.
 *
 * The contact menu and the admin "Shared" tab: only the live shares of that
 * contact; revoked, expired and deleted items leave; at most 50 with
 * "more"; paging past 100; Revoke all touches only that contact,
 * changes no level and leaves the code working.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/contact-shares.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('contact shares on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  let codes: typeof import('./contact-share-codes');
  let cs: typeof import('./contact-shares');
  let sh: typeof import('./shares');
  let access: typeof import('./access');
  let memberApps: typeof import('./member-apps');
  let clientApps: typeof import('./client-apps');
  let log: typeof import('./share-access-log');

  const owner = randomUUID();
  const tag = `cshare-${owner.slice(0, 8)}`;
  const contactA = randomUUID();
  const contactB = randomUUID();
  const contactC = randomUUID();
  const page = randomUUID();
  const app = randomUUID();
  const folder = randomUUID();
  const note = randomUUID();
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });

  const exec = async <T>(q: ReturnType<typeof sqlTag>) => (await m.db.execute(q)) as unknown as T[];
  const levelOf = async (id: string) =>
    (await exec<{ a: string }>(sqlTag`select audience as a from nodes where id = ${id}`))[0]!.a;
  const liveContactShares = async (nodeId: string) =>
    (
      await exec<{ n: number }>(
        sqlTag`select count(*)::int as n from shares where node_id = ${nodeId}
                 and contact_id is not null and revoked_at is null`,
      )
    )[0]!.n;
  /** A statement the database refuses: drizzle wraps the Postgres error,
   *  so match the cause's message and constraint too. */
  const refused = async (q: ReturnType<typeof sqlTag>, re: RegExp) => {
    let text = '';
    try {
      await m.db.execute(q);
    } catch (err) {
      const cause = (err as { cause?: { message?: string; constraint_name?: string } }).cause;
      text = `${(err as Error).message} ${cause?.message ?? ''} ${cause?.constraint_name ?? ''}`;
    }
    expect(text).toMatch(re);
  };
  const insertNodes = async (rows: Array<[string, string, string, string]>) => {
    for (const [id, type, title, path] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path) values (${id}, ${owner}, ${type}, ${title}, ${path})`);
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    codes = await import('./contact-share-codes');
    cs = await import('./contact-shares');
    sh = await import('./shares');
    access = await import('./access');
    memberApps = await import('./member-apps');
    clientApps = await import('./client-apps');
    log = await import('./share-access-log');
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await insertNodes([
      [contactA, 'contact', `${tag} Ann`, 'contacts'],
      [contactB, 'contact', `${tag} Ben`, 'contacts'],
      [contactC, 'contact', `${tag} Cas`, 'contacts'],
      [page, 'page', `${tag} page`, 'pages'],
      [app, 'app', `${tag} app`, 'apps'],
      [folder, 'branch', `${tag} folder`, `files.${tag.replace(/-/g, '_')}`],
      [note, 'note', `${tag} note`, 'notes'],
    ]);
    await m.db.execute(sqlTag`
      insert into apps (node_id, manifest, published_build) values (${app}, '{}'::jsonb, ${green}::jsonb)`);
    for (const c of [contactA, contactB]) {
      expect(await codes.enableContactSharing(owner, c)).toMatchObject({
        code: expect.any(String),
      });
    }
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from share_access_log where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from contact_share_codes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  describe('data', () => {
    it('two contacts and the open link live side by side on one item', async () => {
      const made = await cs.createContactShares(owner, page, [contactA, contactB]);
      expect(made.map((s) => s.contactId).sort()).toEqual([contactA, contactB].sort());
      const open = await sh.createShare(owner, page);
      expect(open.contactId).toBeNull();
      expect(await liveContactShares(page)).toBe(2);
      // The open link is the one open link; a contact token never resolves
      // on the open read path, only on the gated one.
      expect((await sh.getActiveShareForNode(owner, page))?.id).toBe(open.id);
      const token = made[0]!.path.slice(3);
      expect(await sh.resolveActiveShareByToken(token)).toBeNull();
      expect((await sh.resolveActiveShareRowByToken(token))?.contactId).toBe(made[0]!.contactId);
      expect((await sh.resolveActiveShareByToken(open.token))?.id).toBe(open.id);
      // Each contact has its own token.
      expect(new Set(made.map((s) => s.path)).size).toBe(2);
    });

    it('refuses a second live share for the same contact; asking again returns the first', async () => {
      const [first] = await cs.createContactShares(owner, page, [contactA]);
      const [again] = await cs.createContactShares(owner, page, [contactA]);
      expect(again!.shareId).toBe(first!.shareId);
      await refused(
        sqlTag`
          insert into shares (token, owner_id, node_id, node_type, contact_id)
          values (${randomUUID()}, ${owner}, ${page}, 'page', ${contactA})`,
        /shares_node_contact_uq/,
      );
    });

    it('refuses a folder, by the rules and by the database', async () => {
      await expect(cs.createContactShares(owner, folder, [contactA])).rejects.toMatchObject({
        reason: 'folder',
      });
      await refused(
        sqlTag`
          insert into shares (token, owner_id, node_id, node_type, contact_id)
          values (${randomUUID()}, ${owner}, ${folder}, 'branch', ${contactA})`,
        /not a folder/,
      );
    });

    it('the CHECK refuses can_write on a page; the trigger a share to a non-contact', async () => {
      await refused(
        sqlTag`
          insert into shares (token, owner_id, node_id, node_type, contact_id, can_write)
          values (${randomUUID()}, ${owner}, ${note}, 'note', ${contactB}, true)`,
        /shares_can_write_ck/,
      );
      await refused(
        sqlTag`
          insert into shares (token, owner_id, node_id, node_type, can_write)
          values (${randomUUID()}, ${owner}, ${app}, 'app', true)`,
        /shares_can_write_ck/,
      );
      await refused(
        sqlTag`
          insert into shares (token, owner_id, node_id, node_type, contact_id)
          values (${randomUUID()}, ${owner}, ${note}, 'note', ${page})`,
        /not a contact/,
      );
      await expect(cs.createContactShares(owner, note, [contactA], true)).rejects.toMatchObject({
        reason: 'write-not-app',
      });
      await expect(cs.createContactShares(owner, note, [page])).rejects.toMatchObject({
        reason: 'not-a-contact',
      });
      await expect(cs.createContactShares(owner, note, [contactC])).rejects.toMatchObject({
        reason: 'sharing-off',
      });
    });

    it('deleting a contact removes its shares and its code row', async () => {
      const gone = randomUUID();
      await insertNodes([[gone, 'contact', `${tag} Gone`, 'contacts']]);
      await codes.enableContactSharing(owner, gone);
      await cs.createContactShares(owner, note, [gone]);
      await m.db.execute(sqlTag`delete from nodes where id = ${gone}`);
      const left = await exec<{ s: number; c: number }>(sqlTag`
        select (select count(*)::int from shares where contact_id = ${gone}) as s,
               (select count(*)::int from contact_share_codes where contact_id = ${gone}) as c`);
      expect(left[0]).toEqual({ s: 0, c: 0 });
    });

    it('switch off revokes every share; Enable starts fresh, the epoch only goes up', async () => {
      const off = randomUUID();
      await insertNodes([[off, 'contact', `${tag} Off`, 'contacts']]);
      await codes.enableContactSharing(owner, off);
      const before = await codes.contactShareGateRow(off);
      await cs.createContactShares(owner, note, [off]);
      expect(await codes.disableContactSharing(owner, off)).toEqual({ revoked: 1 });
      const disabled = await codes.contactShareGateRow(off);
      expect(disabled?.open).toBe(false);
      expect(disabled!.codeEpoch).toBeGreaterThan(before!.codeEpoch);
      await codes.enableContactSharing(owner, off);
      const after = await codes.contactShareGateRow(off);
      expect(after?.open).toBe(true);
      // A cookie minted at the first epoch can never match again.
      expect(after!.codeEpoch).toBeGreaterThan(disabled!.codeEpoch);
      expect(await codes.contactSharingFor(owner, off)).toMatchObject({ shareCount: 0 });
      expect((await cs.listContactShares(owner, off)).items).toEqual([]);
    });

    it('reaps share_access_log rows older than 90 days, and only those', async () => {
      const [s] = await cs.createContactShares(owner, note, [contactA]);
      const now = new Date();
      const old = new Date(now.getTime() - 91 * 24 * 3600 * 1000).toISOString();
      const fresh = new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString();
      await m.db.execute(sqlTag`
        insert into share_access_log (owner_id, share_id, contact_id, kind, created_at) values
          (${owner}, ${s!.shareId}, ${contactA}, 'open', ${old}::timestamptz),
          (${owner}, ${s!.shareId}, ${contactA}, 'open', ${fresh}::timestamptz)`);
      expect((await log.reapShareAccessLog({ now, dryRun: true })).deleted).toBeGreaterThanOrEqual(
        1,
      );
      await log.reapShareAccessLog({ now });
      const rows = await log.listShareAccess(owner, s!.shareId);
      expect(rows.map((r) => r.createdAt.slice(0, 10))).toEqual([fresh.slice(0, 10)]);
    });
  });

  describe('levels', () => {
    it('a level change to admin, team, client or public never revokes a contact share', async () => {
      const item = randomUUID();
      await insertNodes([[item, 'note', `${tag} levels`, 'notes']]);
      await cs.createContactShares(owner, item, [contactA, contactB]);
      for (const level of ['team', 'client', 'public', 'admin', 'public', 'team'] as const) {
        await access.setItemLevel(owner, item, level);
        expect(await levelOf(item), level).toBe(level);
        expect(await liveContactShares(item), level).toBe(2);
      }
      // The open link followed the levels and nothing else: none at team.
      expect(await sh.getActiveShareForNode(owner, item)).toBeNull();
    });

    it('removing a contact share is a revoke only: no level changes', async () => {
      const item = randomUUID();
      await insertNodes([[item, 'note', `${tag} unshare`, 'notes']]);
      for (const level of ['admin', 'team', 'client', 'public'] as const) {
        await access.setItemLevel(owner, item, level);
        const [s] = await cs.createContactShares(owner, item, [contactA]);
        const r = await access.unshareItem(owner, s!.shareId);
        expect(r, level).toEqual({ revoked: true, stillBelow: [] });
        expect(await levelOf(item), level).toBe(level);
      }
    });

    it('the open-link paths make and revoke only the open link', async () => {
      const item = randomUUID();
      await insertNodes([[item, 'note', `${tag} open`, 'notes']]);
      await cs.createContactShares(owner, item, [contactA]);
      // node_share / the email link: createShare.
      const open = await sh.createShare(owner, item);
      expect(await levelOf(item)).toBe('public');
      expect(await liveContactShares(item)).toBe(1);
      // node_unshare / DELETE /api/shares/:id on the open link.
      await access.unshareItem(owner, open.id);
      expect(await levelOf(item)).toBe('admin');
      expect(await liveContactShares(item)).toBe(1);
      expect(await sh.getActiveShareForNode(owner, item)).toBeNull();
    });

    it('a contact-shared admin app is in no member or client launcher', async () => {
      await cs.createContactShares(owner, app, [contactA], true);
      expect(await levelOf(app)).toBe('admin');
      expect((await memberApps.listMemberApps(owner)).map((a) => a.id)).not.toContain(app);
      expect((await clientApps.listClientApps(owner)).map((a) => a.id)).not.toContain(app);
      expect(await memberApps.getMemberRunnableApp(owner, app)).toBeNull();
    });
  });

  describe('codes', () => {
    it('a right code opens; a wrong one does not', async () => {
      const c = randomUUID();
      await insertNodes([[c, 'contact', `${tag} Codes`, 'contacts']]);
      const { code } = (await codes.enableContactSharing(owner, c)) as { code: string };
      const [s] = await cs.createContactShares(owner, note, [c]);
      const share = { id: s!.shareId, ownerId: owner, contactId: c };
      expect(await codes.checkContactShareCode(share, 'wrongcode')).toMatchObject({ ok: false });
      const ok = await codes.checkContactShareCode(share, ` ${code.slice(0, 4)} ${code.slice(4)} `);
      expect(ok).toMatchObject({ ok: true, contactId: c, ownerId: owner });
      // Another contact's code never opens this contact's share.
      const other = { id: s!.shareId, ownerId: owner, contactId: contactB };
      expect(await codes.checkContactShareCode(other, code)).toMatchObject({ ok: false });
    });

    it('10 failures an hour close a share; 30 a day lock the contact, counted in the database', async () => {
      const c = randomUUID();
      const items = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await insertNodes([
        [c, 'contact', `${tag} Lock`, 'contacts'],
        ...items.map(
          (id, i) => [id, 'note', `${tag} lock ${i}`, 'notes'] as [string, string, string, string],
        ),
      ]);
      const { code } = (await codes.enableContactSharing(owner, c)) as { code: string };
      const shares = [];
      for (const id of items) {
        const [s] = await cs.createContactShares(owner, id, [c]);
        shares.push({ id: s!.shareId, ownerId: owner, contactId: c });
      }
      // Ten failures on share 0: then even the right code is refused there.
      for (let i = 0; i < 10; i++) {
        expect(await codes.checkContactShareCode(shares[0]!, 'xxxxxxxx')).toMatchObject({
          ok: false,
          lockedNow: false,
        });
      }
      expect(await codes.checkContactShareCode(shares[0]!, code)).toMatchObject({ ok: false });
      // Fresh module state (a restart): the counts live in the database.
      vi.resetModules();
      const fresh = await import('./contact-share-codes');
      expect(await fresh.checkContactShareCode(shares[0]!, code)).toMatchObject({ ok: false });
      // 12 failures so far. 18 more on other shares reach 30: locked.
      let locked = false;
      for (let i = 0; i < 18; i++) {
        const r = await fresh.checkContactShareCode(shares[1 + (i % 2)]!, 'yyyyyyyy');
        if (!r.ok && r.lockedNow) locked = true;
      }
      expect(locked).toBe(true);
      expect((await fresh.contactShareGateRow(c))?.open).toBe(false);
      expect(await fresh.contactSharingFor(owner, c)).toMatchObject({ locked: true });
      // Locked: the right code fails on a fresh share too.
      expect(await fresh.checkContactShareCode(shares[3]!, code)).toMatchObject({ ok: false });
      // "Needs you" counts it.
      expect((await fresh.lockedContactSharing(owner)).count).toBeGreaterThanOrEqual(1);
      // Regenerate clears the lock; the new code opens a share with no failures.
      const { code: next } = (await fresh.regenerateContactCode(owner, c))!;
      expect((await fresh.contactShareGateRow(c))?.open).toBe(true);
      expect(await fresh.checkContactShareCode(shares[3]!, code)).toMatchObject({ ok: false });
      expect(await fresh.checkContactShareCode(shares[3]!, next)).toMatchObject({ ok: true });
    });
  });

  describe('the contact menu and the Shared tab', () => {
    const menuContact = randomUUID();
    const otherContact = randomUUID();
    const many = Array.from({ length: 105 }, () => randomUUID());

    beforeAll(async () => {
      await insertNodes([
        [menuContact, 'contact', `${tag} Menu`, 'contacts'],
        [otherContact, 'contact', `${tag} Other`, 'contacts'],
        ...many.map(
          (id, i) =>
            [id, 'note', `${tag} n${String(i).padStart(3, '0')}`, 'notes'] as [
              string,
              string,
              string,
              string,
            ],
        ),
      ]);
      await codes.enableContactSharing(owner, menuContact);
      await codes.enableContactSharing(owner, otherContact);
      for (const id of many) await cs.createContactShares(owner, id, [menuContact]);
      await cs.createContactShares(owner, many[0]!, [otherContact]);
    }, 120_000);

    // One query: pinned without a database in contact-shares.test.ts.
    it('lists at most 50 live shares of that contact, with "more"', async () => {
      const r = await cs.listContactShares(owner, menuContact, { limit: 50 });
      expect(r.items).toHaveLength(50);
      expect(r.more).toBe(true);
      expect(Object.keys(r.items[0]!).sort()).toEqual(['icon', 'kind', 'title', 'token']);
      const other = await cs.listContactShares(owner, otherContact);
      expect(other.items.map((i) => i.title)).toEqual([`${tag} n000`]);
      expect(other.more).toBe(false);
    });

    it('a revoked, an expired and a deleted item leave the list', async () => {
      const all = async () =>
        (await cs.listContactSharesForAdmin(owner, menuContact)).shares.map((s) => s.nodeId);
      const [revoke, expire, remove] = [many[104]!, many[103]!, many[102]!];
      expect(await all()).toEqual(expect.arrayContaining([revoke, expire, remove]));
      const row = (await cs.listContactSharesForAdmin(owner, menuContact)).shares.find(
        (s) => s.nodeId === revoke,
      )!;
      await access.unshareItem(owner, row.shareId);
      await m.db.execute(sqlTag`
        update shares set expires_at = now() - interval '1 minute'
         where node_id = ${expire} and contact_id = ${menuContact}`);
      await m.db.execute(sqlTag`delete from nodes where id = ${remove}`);
      const left = await all();
      for (const id of [revoke, expire, remove]) expect(left).not.toContain(id);
      const tokens = (await cs.listContactShares(owner, menuContact)).items.map((i) => i.title);
      expect(tokens).not.toContain(`${tag} n104`);
    });

    it('pages the Shared tab past 100, newest first, only this contact', async () => {
      const first = await cs.listContactSharesForAdmin(owner, menuContact);
      expect(first.shares).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      const second = await cs.listContactSharesForAdmin(owner, menuContact, first.nextCursor);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.shares, ...second.shares].map((s) => s.nodeId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(102); // 105 less the revoked, expired and deleted
      const times = [...first.shares, ...second.shares].map((s) => s.sharedAt);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it("Revoke all ends only this contact's shares, changes no level, keeps the code", async () => {
      await access.setItemLevel(owner, many[0]!, 'team');
      const n = await cs.revokeAllContactShares(owner, menuContact);
      expect(n).toBe(102);
      expect((await cs.listContactSharesForAdmin(owner, menuContact)).shares).toEqual([]);
      expect((await cs.listContactShares(owner, otherContact)).items).toHaveLength(1);
      expect(await levelOf(many[0]!)).toBe('team');
      expect((await codes.contactShareGateRow(menuContact))?.open).toBe(true);
      expect(await codes.contactSharingFor(owner, menuContact)).toMatchObject({ shareCount: 0 });
    });
  });
});

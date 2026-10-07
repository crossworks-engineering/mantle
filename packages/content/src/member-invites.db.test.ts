/**
 * Member invites (member logins, Phase 6) on a real, migrated Postgres:
 * create, list, revoke and redeem. Single use, expiry, revoke, a wrong code
 * is the same null as any other failure, an old 8-char team code redeems
 * nothing (team codes are retired, migration 0178), an invite stored before
 * 0178 still redeems, the redeem creates a member login linked to the
 * contact, and a failed redeem writes nothing.
 * Seeds its own brain row, logins and contacts, removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-invites.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('member invites', () => {
  type Mod = typeof import('./member-invites');
  let inv: Mod;
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `inv-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const otherBrain = randomUUID();
  const adminLogin = randomUUID();
  const ids = {
    pat: randomUUID(), // plain contact with an email
    sam: randomUUID(), // held an old team code
    lee: randomUUID(), // linked to a login already
    kim: randomUUID(), // domain wildcard only, no address
    ray: randomUUID(), // for the race
    tia: randomUUID(), // invited before 0178
    foreign: randomUUID(), // another brain's contact
    note: randomUUID(), // not a contact
  };
  const email = (who: string) => `${who}-${tag}@example.invalid`;
  const HASH = '$2a$12$not-a-real-hash-but-stored-as-given';

  const inviteRow = async (id: string) =>
    (await admin<Row[]>`select * from member_invites where id = ${id}`)[0]!;
  const loginByEmail = async (e: string) =>
    (await admin<Row[]>`select * from auth.users where lower(email) = ${e}`)[0] ?? null;
  const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
  const accessRows = async () =>
    admin<Row[]>`select contact_id, kind, detail from team_access_log where owner_id = ${anchor}
                  order by created_at`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    inv = await import('./member-invites');
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${email('anchor')}, 'x', 'admin'),
      (${otherBrain}, ${email('other')}, 'x', 'admin'),
      (${adminLogin}, ${email('admin')}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${otherBrain}, 'brain', ${otherBrain})`;
    const data = (emails: string[]) => JSON.stringify({ emails });
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${ids.pat}, ${anchor}, 'contact', 'Pat Doe', 'contacts', ${data([email('pat')])}::jsonb),
      (${ids.sam}, ${anchor}, 'contact', 'Sam', 'contacts', ${data([email('sam')])}::jsonb),
      (${ids.lee}, ${anchor}, 'contact', 'Lee', 'contacts', ${data([email('lee')])}::jsonb),
      (${ids.kim}, ${anchor}, 'contact', 'Kim', 'contacts', ${data(['@example.invalid'])}::jsonb),
      (${ids.ray}, ${anchor}, 'contact', 'Ray', 'contacts', ${data([email('ray')])}::jsonb),
      (${ids.tia}, ${anchor}, 'contact', 'Tia', 'contacts', ${data([email('tia')])}::jsonb),
      (${ids.foreign}, ${otherBrain}, 'contact', 'Far', 'contacts', ${data([email('far')])}::jsonb),
      (${ids.note}, ${anchor}, 'note', 'a note', 'notes', '{}'::jsonb)`;
    await admin`insert into auth.users (id, email, password_hash, role, contact_id)
                values (${randomUUID()}, ${email('lee-login')}, 'x', 'member', ${ids.lee})`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const logins = await admin<Row[]>`select id from auth.users where email like ${`%${tag}%`}`;
    const loginIds = logins.map((r) => r.id as string);
    await admin`delete from member_invites where owner_id in (${anchor}, ${otherBrain})`;
    await admin`delete from team_access_log where owner_id in (${anchor}, ${otherBrain})`;
    await admin`delete from nodes where owner_id in (${anchor}, ${otherBrain})`;
    if (loginIds.length === 0) return m.closeDb();
    await admin`delete from spaces where login_id in ${admin(loginIds as never)}`;
    await admin`delete from spaces where id in (${anchor}, ${otherBrain})`;
    await admin`delete from auth.users where id in ${admin(loginIds as never)}`;
    await m.closeDb();
  });

  describe('create', () => {
    it("defaults the email and name to the contact's and stores only a hash", async () => {
      const { invite, code } = await inv.createMemberInvite(anchor, {
        contactId: ids.pat,
        createdBy: adminLogin,
      });
      expect(code).toHaveLength(inv.MEMBER_INVITE_CODE_LENGTH);
      expect(invite).toMatchObject({
        contactId: ids.pat,
        contactName: 'Pat Doe',
        email: email('pat'),
        displayName: 'Pat Doe',
        state: 'open',
        createdBy: adminLogin,
      });
      const row = await inviteRow(invite.id);
      expect(row.code_hash).toBe(sha256(code));
      expect(JSON.stringify(row)).not.toContain(code);
      const hours =
        (new Date(row.expires_at as string).getTime() -
          new Date(row.created_at as string).getTime()) /
        36e5;
      expect(hours).toBe(72);
    });

    it('refuses a contact of another brain, a non-contact, a linked contact, no address', async () => {
      const refusals: Array<[Record<string, string>, string]> = [
        [{ contactId: ids.foreign }, 'contact-not-found'],
        [{ contactId: ids.note }, 'contact-not-found'],
        [{ contactId: ids.lee }, 'contact-has-login'],
        [{ contactId: ids.kim }, 'no-email'],
        [{}, 'no-email'],
        [{ email: email('ANCHOR') }, 'email-has-login'],
      ];
      for (const [input, reason] of refusals) {
        await expect(
          inv.createMemberInvite(anchor, { ...input, createdBy: adminLogin }),
          reason,
        ).rejects.toMatchObject({ name: 'MemberInviteError', reason });
      }
    });

    it('replaces an open invite for the same contact (the old code dies)', async () => {
      const first = await inv.createMemberInvite(anchor, {
        contactId: ids.ray,
        createdBy: adminLogin,
      });
      const second = await inv.createMemberInvite(anchor, {
        contactId: ids.ray,
        createdBy: adminLogin,
      });
      expect((await inviteRow(first.invite.id)).revoked_at).not.toBeNull();
      expect(await inv.previewMemberInvite(first.code)).toBeNull();
      expect(await inv.previewMemberInvite(second.code)).toMatchObject({ email: email('ray') });
      const listed = (await inv.listMemberInvites(anchor)).map((r) => r.id);
      expect(listed).toContain(second.invite.id);
      expect(listed).not.toContain(first.invite.id);
    });

    it('holds one open invite per contact in the database itself', async () => {
      await expect(
        admin`insert into member_invites (owner_id, contact_id, email, code_hash, expires_at)
              values (${anchor}, ${ids.ray}, 'x@example.invalid', ${`dup-${tag}`}, now())`,
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('redeem', () => {
    it('creates a member login linked to the contact, once, and logs it', async () => {
      const { invite, code } = await inv.createMemberInvite(anchor, {
        contactId: ids.pat,
        createdBy: adminLogin,
      });
      const out = await inv.redeemMemberInvite({ code, passwordHash: HASH });
      expect(out).toMatchObject({
        email: email('pat'),
        ownerId: anchor,
        contactId: ids.pat,
        inviteId: invite.id,
        via: 'invite',
      });
      const login = await loginByEmail(email('pat'));
      expect(login).toMatchObject({
        id: out!.loginId,
        role: 'member',
        contact_id: ids.pat,
        display_name: 'Pat Doe',
        password_hash: HASH,
        is_owner: false,
        disabled_at: null,
      });
      const row = await inviteRow(invite.id);
      expect(row.redeemed_at).not.toBeNull();
      expect(row.redeemed_login_id).toBe(out!.loginId);
      const logged = (await accessRows()).filter((r) => r.contact_id === ids.pat);
      expect(logged).toEqual([
        {
          contact_id: ids.pat,
          kind: 'auth',
          detail: {
            event: 'invite_redeemed',
            via: 'invite',
            inviteId: invite.id,
            loginId: out!.loginId,
          },
        },
      ]);

      // Single use.
      expect(await inv.redeemMemberInvite({ code, passwordHash: HASH })).toBeNull();
      expect(await inv.previewMemberInvite(code)).toBeNull();
      const [counted] = await admin<Row[]>`select count(*)::int as n from auth.users
                                         where contact_id = ${ids.pat}`;
      expect(counted!.n).toBe(1);
      expect((await inv.listMemberInvites(anchor)).find((r) => r.id === invite.id)?.state).toBe(
        'redeemed',
      );
    });

    it('redeems nothing with an old 8-char team code, even while the contact has an open invite', async () => {
      const before = (await accessRows()).length;
      const { invite, code } = await inv.createMemberInvite(anchor, {
        contactId: ids.sam,
        createdBy: adminLogin,
      });
      // What a team code looked like: 8 characters of the same alphabet. The
      // invite code's own first 8 and a code one character too long are
      // misses too: only the whole 16-char invite code redeems.
      for (const wrong of ['Akk34DMx', code.slice(0, 8), `${code}x`]) {
        expect(await inv.previewMemberInvite(wrong), wrong).toBeNull();
        expect(await inv.redeemMemberInvite({ code: wrong, passwordHash: HASH }), wrong).toBeNull();
      }
      expect(await loginByEmail(email('sam'))).toBeNull();
      expect((await inviteRow(invite.id)).redeemed_at).toBeNull();
      expect((await accessRows()).length).toBe(before);

      // The invite code itself (spaces around it trimmed) still redeems.
      const out = await inv.redeemMemberInvite({ code: ` ${code} `, passwordHash: HASH });
      expect(out).toMatchObject({ via: 'invite', inviteId: invite.id, contactId: ids.sam });
      expect((await loginByEmail(email('sam')))?.role).toBe('member');
    });

    it('redeems an invite made before 0178 (its code stored as the plain SHA-256)', async () => {
      const code = 'Pq7RsTuVwXyZ2345';
      const id = randomUUID();
      await admin`insert into member_invites
                    (id, owner_id, contact_id, email, display_name, code_hash, created_by, expires_at)
                  values (${id}, ${anchor}, ${ids.tia}, ${email('tia')}, 'Tia', ${sha256(code)},
                          ${adminLogin}, now() + interval '1 hour')`;
      expect(await inv.previewMemberInvite(code)).toMatchObject({ email: email('tia') });
      const out = await inv.redeemMemberInvite({ code, passwordHash: HASH });
      expect(out).toMatchObject({ via: 'invite', inviteId: id, contactId: ids.tia });
      expect((await inviteRow(id)).redeemed_login_id).toBe(out!.loginId);
    });

    it('fails the same way, writing nothing, for a wrong, expired, revoked code or a wrong email', async () => {
      const before = (await accessRows()).length;
      const expired = await inv.createMemberInvite(
        anchor,
        { email: email('old'), createdBy: adminLogin },
        new Date(Date.now() - 73 * 36e5),
      );
      const revoked = await inv.createMemberInvite(anchor, {
        email: email('rev'),
        createdBy: adminLogin,
      });
      await inv.revokeMemberInvite(anchor, revoked.invite.id);
      const open = await inv.createMemberInvite(anchor, {
        email: email('open'),
        createdBy: adminLogin,
      });

      const attempts = [
        { code: 'ZZZZZZZZZZZZZZZZ' },
        { code: expired.code },
        { code: revoked.code },
        { code: open.code, email: email('someone-else') },
        { code: '' },
      ];
      for (const a of attempts) {
        expect(await inv.redeemMemberInvite({ ...a, passwordHash: HASH }), a.code).toBeNull();
        // The preview names the invite's email, so it has no email to check.
        if (!a.email) expect(await inv.previewMemberInvite(a.code)).toBeNull();
      }
      for (const who of ['old', 'rev', 'open', 'someone-else']) {
        expect(await loginByEmail(email(who))).toBeNull();
      }
      expect((await inviteRow(open.invite.id)).redeemed_at).toBeNull();
      expect((await accessRows()).length).toBe(before);
      const states = new Map((await inv.listMemberInvites(anchor)).map((r) => [r.id, r.state]));
      expect(states.get(expired.invite.id)).toBe('expired');
      expect(states.get(open.invite.id)).toBe('open');
      expect(states.has(revoked.invite.id)).toBe(false);

      // The right email (any case) redeems the open one.
      const ok = await inv.redeemMemberInvite({
        code: open.code,
        email: email('open').toUpperCase(),
        passwordHash: HASH,
      });
      expect(ok?.email).toBe(email('open'));
      expect(ok?.contactId).toBeNull();
    });

    it('refuses when a login took the email after the invite was made', async () => {
      const { code, invite } = await inv.createMemberInvite(anchor, {
        email: email('late'),
        createdBy: adminLogin,
      });
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${randomUUID()}, ${email('LATE')}, 'x', 'admin')`;
      expect(await inv.redeemMemberInvite({ code, passwordHash: HASH })).toBeNull();
      expect((await inviteRow(invite.id)).redeemed_at).toBeNull();
    });

    it('lets exactly one of two racing redeems win', async () => {
      const { code } = await inv.createMemberInvite(anchor, {
        contactId: ids.ray,
        createdBy: adminLogin,
      });
      const results = await Promise.all([
        inv.redeemMemberInvite({ code, passwordHash: HASH }),
        inv.redeemMemberInvite({ code, passwordHash: HASH }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const [counted] = await admin<Row[]>`select count(*)::int as n from auth.users
                                         where contact_id = ${ids.ray}`;
      expect(counted!.n).toBe(1);
    });
  });

  describe('revoke and list', () => {
    it('revokes only an open invite of this brain', async () => {
      const { invite } = await inv.createMemberInvite(anchor, {
        email: email('gone'),
        createdBy: adminLogin,
      });
      expect(await inv.revokeMemberInvite(otherBrain, invite.id)).toBe(false);
      expect(await inv.revokeMemberInvite(anchor, invite.id)).toBe(true);
      expect(await inv.revokeMemberInvite(anchor, invite.id)).toBe(false);
      const redeemed = (await inv.listMemberInvites(anchor)).find((r) => r.state === 'redeemed')!;
      expect(await inv.revokeMemberInvite(anchor, redeemed.id)).toBe(false);
    });

    it("lists this brain's invites only, never a code", async () => {
      await inv.createMemberInvite(otherBrain, { email: email('far'), createdBy: otherBrain });
      const rows = await inv.listMemberInvites(anchor);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.email !== email('far'))).toBe(true);
      for (const r of rows) {
        expect(Object.keys(r)).not.toContain('code');
        expect(Object.keys(r)).not.toContain('codeHash');
      }
    });
  });
});

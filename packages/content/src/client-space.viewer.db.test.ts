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
  let sh: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `cspace-${randomUUID().slice(0, 8)}`;
  let brain = '';
  const client = randomUUID();
  const member = randomUUID();
  const adminA = randomUUID();
  // Accept moves items into a brain of this test's own (it creates the
  // brain's root folders, which the shared anchor must never gain from a test).
  const acceptBrain = randomUUID();
  const logins = [client, member, adminA];
  const spaceOf: Record<string, string> = {};
  const brainItems = { team: randomUUID(), client: randomUUID(), pub: randomUUID() };
  // A file of the Accept brain, at client: a client's page embeds it (audit
  // A28, the closure an Accept takes down).
  const acceptFile = randomUUID();
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
    sh = await import('./shares');
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
        (${adminA}, ${`${tag}-a@example.invalid`}, 'x', 'admin', null),
        (${acceptBrain}, ${`${tag}-b@example.invalid`}, 'x', 'admin', null)`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${acceptBrain}, 'brain', ${acceptBrain})`);
    const rows = await exec<{ id: string; login_id: string }>(sqlTag`
      select id, login_id from spaces where kind = 'personal'
        and login_id in (${client}, ${member}, ${adminA})`);
    for (const r of rows) spaceOf[r.login_id] = r.id;
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${brainItems.team}, ${brain}, 'note', ${`${tag} team note`}, 'notes', 'team'),
        (${brainItems.client}, ${brain}, 'note', ${`${tag} client note`}, 'notes', 'client'),
        (${brainItems.pub}, ${brain}, 'note', ${`${tag} public note`}, 'notes', 'public'),
        (${acceptFile}, ${acceptBrain}, 'file', ${`${tag} plan.png`}, 'files', 'client')`);
    // Imports the review, take-over and share modules: a loaded run needs time.
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${acceptBrain}`);
    await m.systemDb.execute(
      sqlTag`delete from spaces where id = ${acceptBrain} or login_id = ${acceptBrain}`,
    );
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${acceptBrain}`);
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

  it('withSpace refuses a login that does not exist', async () => {
    await expect(
      m.withSpace({ spaceId: spaceOf[client]!, loginId: randomUUID() }, async () => 1),
    ).rejects.toThrow(/no such login/);
  });

  it('the embed rule reads at the author’s level: a client may not name a team item', async () => {
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
    // A public item is not a client item either (decision 3).
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

  it('Accept of a client’s item defaults to team; client needs a confirmation', async () => {
    const reviewer = { loginId: adminA };
    const first = await submitted(client, `${tag} request 1`, [brainItems.client]);
    const res = await rv.acceptReviewItem(acceptBrain, first, reviewer);
    expect(res.audience).toBe('team');
    expect(await audienceOf(first)).toBe('team');

    const second = await submitted(client, `${tag} request 2`);
    for (const audience of ['client', 'public'] as const) {
      await expect(
        rv.acceptReviewItem(acceptBrain, second, reviewer, { audience }),
      ).rejects.toMatchObject({ reason: 'confirm-level' });
    }
    expect(await audienceOf(second)).toBe('admin'); // still the client's, untouched
    const confirmed = await rv.acceptReviewItem(acceptBrain, second, reviewer, {
      audience: 'client',
      lowerConfirmed: true,
    });
    expect(confirmed.audience).toBe('client');
    expect(await audienceOf(second)).toBe('client');

    // A member's item (control): admin by default, as before.
    const third = await submitted(member, `${tag} member request`);
    expect((await rv.acceptReviewItem(acceptBrain, third, reviewer)).audience).toBe('admin');
  });

  it('acceptAudience: the rule by role, with no database', () => {
    expect(rv.acceptAudience('member', {})).toBe('admin');
    expect(rv.acceptAudience(null, {})).toBe('admin');
    expect(rv.acceptAudience('client', {})).toBe('team');
    expect(rv.acceptAudience('client', { audience: 'admin' })).toBe('admin');
    expect(() => rv.acceptAudience('client', { audience: 'client' })).toThrow(/client wrote/);
    expect(rv.acceptAudience('client', { audience: 'public', lowerConfirmed: true })).toBe(
      'public',
    );
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
  it('give back reads an absolute URL into this brain as the item it names (audit L2)', async () => {
    const id = await submitted(client, `${tag} linked`);
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    await rv.takeOverReviewItem(id, actor);
    const A = actor.spaceId;
    const writer = { adminOfBrain: brain };
    // The admin links a TEAM item by its absolute URL while it is theirs.
    const linked = async (href: string) => {
      const doc = say('admin', [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Team plan', marks: [{ type: 'link', attrs: { href } }] },
          ],
        },
      ]);
      expect((await as(adminA, () => sp.saveMinePage(A, id, doc, writer))).ok, href).toBe(true);
    };
    const before = process.env.MANTLE_PUBLIC_URL;
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    try {
      for (const href of [
        `https://brain.example.invalid/pages/${brainItems.team}`,
        `https://other.example.invalid/n/${brainItems.team}`,
      ]) {
        await linked(href);
        await expect(tk.giveBackTakenItem(brain, actor, id, 'Fix it'), href).rejects.toMatchObject({
          reason: 'embed',
          ids: [brainItems.team],
        });
      }
      // An external link still goes back.
      await linked('https://example.com/plan');
      const back = await tk.giveBackTakenItem(brain, actor, id, 'Fix it');
      expect(back.returned.map((b) => b.id)).toEqual([id]);
    } finally {
      if (before === undefined) delete process.env.MANTLE_PUBLIC_URL;
      else process.env.MANTLE_PUBLIC_URL = before;
    }
  });

  /** Make a submitted page embed the Accept brain's file (written by hand:
   *  the save rule reads the shared anchor, and Accept runs in its own). */
  const embedAcceptFile = async (id: string) => {
    const doc = say('with an image', [{ type: 'image', attrs: { nodeId: acceptFile, src: 'x' } }]);
    await m.systemDb.execute(
      sqlTag`update pages set doc = ${JSON.stringify(doc)}::jsonb where node_id = ${id}`,
    );
  };

  it('the review queue names a client author by role, and its counts agree (T7, A28)', async () => {
    const mine = await submitted(client, `${tag} queued`);
    const theirs = await submitted(member, `${tag} queued by a member`);
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`set transaction isolation level repeatable read`);
      const queue = await rv.listReviewQueue(tx);
      expect(queue.items.find((i) => i.id === mine)).toMatchObject({
        reason: 'submitted',
        author: { loginId: client, name: 'Cleo Client', role: 'client', inactive: false },
      });
      expect(queue.items.find((i) => i.id === theirs)?.author.role).toBe('member');
      // One snapshot: the counts are the list's, the client row included.
      expect(await rv.countReviewQueue(tx)).toEqual(queue.counts);
      expect(await rv.countSubmitted(tx)).toBe(
        queue.items.filter((i) => i.reviewState === 'submitted' || i.reviewState === 'taken')
          .length,
      );
    });
    // Return goes back to the client, with the note.
    await rv.returnReviewItem(mine, { loginId: adminA }, 'Say which site.');
    const [row] = await exec<{ review_state: string; returned_note: string }>(
      sqlTag`select review_state, returned_note from space_items where node_id = ${mine}`,
    );
    expect(row).toEqual({ review_state: 'returned', returned_note: 'Say which site.' });
    expect((await rv.listReviewQueue()).items.map((i) => i.id)).not.toContain(mine);
    await rv.returnReviewItem(theirs, { loginId: adminA }, 'Control.');
  });

  it('Accept of a client item at client makes no link, and needs no tick for what stays (A31)', async () => {
    const id = await submitted(client, `${tag} at client`);
    await embedAcceptFile(id);
    const preview = await rv.previewAccept(id, acceptBrain);
    expect(preview?.closure).toEqual([
      { id: acceptFile, type: 'file', title: `${tag} plan.png`, audience: 'client' },
    ]);
    // At client the file does not go down: the level confirmation is enough.
    const res = await rv.acceptReviewItem(
      acceptBrain,
      id,
      { loginId: adminA },
      {
        audience: 'client',
        lowerConfirmed: true,
      },
    );
    expect(res.audience).toBe('client');
    expect(await audienceOf(id)).toBe('client');
    expect(await sh.getActiveShareForNode(acceptBrain, id)).toBeNull();
    expect(await audienceOf(acceptFile)).toBe('client');
  });

  it('Accept of a client item at public needs every closure item that goes down ticked (A28)', async () => {
    const reviewer = { loginId: adminA };
    const id = await submitted(client, `${tag} at public`);
    await embedAcceptFile(id);
    const goingDown = [
      { id: acceptFile, type: 'file', title: `${tag} plan.png`, audience: 'client' },
    ];
    // The level confirmed, the image not ticked: refused, with the list.
    const refused = rv.acceptReviewItem(acceptBrain, id, reviewer, {
      audience: 'public',
      lowerConfirmed: true,
    });
    await expect(refused).rejects.toMatchObject({ reason: 'confirm-level', goingDown });
    await expect(refused).rejects.toThrow(
      /anyone with its open link reads it; client logins do not/,
    );
    // The image ticked, the level not confirmed: refused too.
    await expect(
      rv.acceptReviewItem(acceptBrain, id, reviewer, {
        audience: 'public',
        confirmedIds: [acceptFile],
      }),
    ).rejects.toMatchObject({ reason: 'confirm-level', goingDown });
    expect(await audienceOf(acceptFile)).toBe('client');
    expect(await audienceOf(id)).toBe('admin'); // still the client's, untouched
    // Both: accepted, and the image went down with it.
    const res = await rv.acceptReviewItem(acceptBrain, id, reviewer, {
      audience: 'public',
      lowerConfirmed: true,
      confirmedIds: [acceptFile],
    });
    expect(res.audience).toBe('public');
    expect(res.alsoLowered.map((l) => [l.id, l.from, l.to])).toEqual([
      [acceptFile, 'client', 'public'],
    ]);
    expect(await audienceOf(acceptFile)).toBe('public');
  });

  it("an admin's own Accept after Take over follows the client rule (A6)", async () => {
    const id = await submitted(client, `${tag} taken then accepted`);
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    await rv.takeOverReviewItem(id, actor);
    for (const audience of ['client', 'public'] as const) {
      await expect(rv.acceptOwnItem(acceptBrain, actor, id, { audience })).rejects.toMatchObject({
        reason: 'confirm-level',
      });
    }
    expect(await audienceOf(id)).not.toBe('client');
    // Default: team, as for a reviewed Accept of a client's item.
    const res = await rv.acceptOwnItem(acceptBrain, actor, id);
    expect(res.audience).toBe('team');
    expect(await audienceOf(id)).toBe('team');
  });

  it('a taken client item cannot be deleted while the client can take it back (T7)', async () => {
    const id = await submitted(client, `${tag} taken, then deleted`);
    const actor = { loginId: adminA, spaceId: spaceOf[adminA]! };
    await rv.takeOverReviewItem(id, actor);
    await expect(as(adminA, () => sp.deleteMineItem(actor.spaceId, id))).rejects.toMatchObject({
      reason: 'taken',
    });
    // A deactivated client cannot take it back: then it may go.
    await m.systemDb.execute(
      sqlTag`update auth.users set disabled_at = now() where id = ${client}`,
    );
    try {
      expect(await as(adminA, () => sp.deleteMineItem(actor.spaceId, id))).toBe(true);
    } finally {
      await m.systemDb.execute(
        sqlTag`update auth.users set disabled_at = null where id = ${client}`,
      );
    }
  });
});

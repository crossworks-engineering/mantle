/**
 * Locking a login out, on a real migrated Postgres, through the real routes
 * (the admin session and the relay are stood in):
 *
 *   - a push device belongs to the login that enrolled it (0173): POST
 *     records it, lockout (disable, demote) and delete remove that login's
 *     devices only and tell the relay, and the FK cascades on a raw delete;
 *   - lockout releases the login's personal assistant (the agent survives);
 *   - a member login cannot be given a personal assistant;
 *   - a contact link must be a contact of this brain, not another login's;
 *   - a deleted login's space records when it lost its login (0180, F21),
 *     and a member made admin gets their shared and submitted items back as
 *     private drafts;
 *   - no login row takes the client role (W8a, migration 0272).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run 'server/web/app/api/users/[id]/users-lockout.db.test.ts'
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  caller: null as unknown,
  relayDeleted: [] as string[],
}));

// The admin session, stood in: a route that calls the owner guard gets
// h.caller, and so does one that reads the caller the pipeline answers
// (ownerCaller(), A4 step 3b; this test calls the handler directly, with
// no gate, and its logins have no anchor for the gate to answer).
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.caller),
  getOwnerOr401WithSource: vi.fn(async () => ({ user: h.caller, source: 'web' })),
  ownerCaller: vi.fn(() => h.caller),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => {},
  requestMetaFrom: () => ({}),
}));

vi.mock('@/lib/push/relay-client', () => ({
  relayDeleteDevice: vi.fn(async (_url: string, _token: string, routingToken: string) => {
    h.relayDeleted.push(routingToken);
    return true;
  }),
}));

// The relay identity is sealed under the master key; the tests do not need
// real crypto (the relay itself is stood in above).
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: (plain: string) => ({ ciphertext: Buffer.from(plain, 'utf8') }),
  open: (sealed: Buffer) => sealed.toString('utf8'),
}));

type Row = Record<string, unknown>;

describe.skipIf(!URL)('login lockout: push devices, the assistant, contact links', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  const tag = `lockout-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const otherBrain = randomUUID();
  const bea = randomUUID(); // admin, disabled below
  const cal = randomUUID(); // admin, demoted below
  const dee = randomUUID(); // admin, deleted below
  const eve = randomUUID(); // admin, links contacts
  const raw = randomUUID(); // deleted with raw SQL (the FK)
  const former = randomUUID(); // a former client login (archived by 0272)
  const fay = randomUUID(); // admin, in Admin: the no-users-area caller's target
  const gus = randomUUID(); // member
  const hal = randomUUID(); // role admin, not in Admin (drift)
  const ivy = randomUUID(); // role member, in Admin (drift)
  const noU = randomUUID(); // admin, in Admin, the users area off
  const logins = [anchor, otherBrain, bea, cal, dee, eve, raw, former, fay, gus, hal, ivy, noU];
  const ids = {
    contact: randomUUID(),
    /** The contact a former client login was linked to (W8d). */
    formerContact: randomUUID(),
    otherContact: randomUUID(),
    notContact: randomUUID(),
    foreignContact: randomUUID(),
    source: randomUUID(),
  };
  let createdInstance = false;
  let deeSpace: string | undefined;

  const as = (actorId: string) => ({
    id: anchor,
    email: `${tag}@example.invalid`,
    actor: { id: actorId, email: `${tag}@example.invalid`, displayName: null, isOwner: false },
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (method: string, body: unknown) =>
    new Request('http://x/api/users', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const devicesOf = async (loginId: string) =>
    (
      await admin<Row[]>`select routing_token from push_subscriptions where login_id = ${loginId}
                         order by routing_token`
    ).map((r) => r.routing_token as string);
  /** Enrol a device as `loginId`'s phone does: with that login's bearer (a
   *  device is bound to the token that enrolled it). */
  const enroll = async (loginId: string, token: string) => {
    h.caller = as(loginId);
    const { buildMobileToken } = await import('@/lib/auth');
    const jti = randomUUID();
    const bearer = buildMobileToken(loginId, jti, 3600);
    await admin`insert into mobile_tokens (id, user_id, label, expires_at)
                values (${jti}, ${loginId}, ${tag}, ${bearer.expiresAt.toISOString()})`;
    const { POST } = await import('../../push/subscriptions/route');
    const res = await POST(
      new Request('http://x/api/push/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer.value}` },
        body: JSON.stringify({ routingToken: token, publicKey: 'pk', platform: 'ios' }),
      }) as never,
    );
    expect(res.status).toBe(200);
  };
  const assign = async (loginId: string, slug: string) =>
    admin`insert into agents (owner_id, slug, name, model, system_prompt, assigned_user_id, assigned_at)
          values (${anchor}, ${slug}, ${slug}, 'm', 'p', ${loginId}, now())`;
  const assignedTo = async (slug: string) =>
    (
      await admin<Row[]>`select assigned_user_id from agents
                         where owner_id = ${anchor} and slug = ${slug}`
    )[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'users-lockout-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    // Admin membership decides (S8b): the caller and the admin logins are
    // users of the brain's live Admin workspace, as a box with no role drift
    // has them; the role change adds to it and removes from it.
    // On a superuser client of its own: under the runtime role the app pool
    // only reads the workspace tables, and the role guard (0330) refuses it
    // an admin login.
    const { ensureAdminUsers, superuserClient } = await import('@mantle/db/test-support');
    const su = superuserClient(URL!);
    try {
      for (const id of logins) {
        const role = id === gus || id === ivy || id === former ? 'member' : 'admin';
        await asSuperuser()`insert into auth.users (id, email, password_hash, role)
                 values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
      }
      const adminWs = await ensureAdminUsers(su, [anchor, bea, cal, dee, eve, fay, ivy, noU]);
      await su`update workspace_users set limits = '{"areas": {"users": false}}'::jsonb
                where workspace_id = ${adminWs} and login_id = ${noU}`;
    } finally {
      await su.end();
    }
    // Items belong to a space (0165): each test brain is a brain row.
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${otherBrain}, 'brain', ${otherBrain})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${ids.contact}, ${anchor}, 'contact', 'Pat', 'contacts'),
      (${ids.otherContact}, ${anchor}, 'contact', 'Sam', 'contacts'),
      (${ids.formerContact}, ${anchor}, 'contact', 'Kim', 'contacts'),
      (${ids.notContact}, ${anchor}, 'note', 'a note', 'notes'),
      (${ids.foreignContact}, ${otherBrain}, 'contact', 'Lee', 'contacts')`;
    await admin`insert into agents (id, owner_id, slug, name, model, system_prompt)
                values (${ids.source}, ${anchor}, ${`${tag}-source`}, 'Source', 'm', 'p')`;
    // The relay identity is one row per install; seed it only on a bare DB.
    const [inst] = await admin<Row[]>`select id from push_instance limit 1`;
    if (!inst) {
      const { savePushInstance } = await import('@/lib/push/store');
      await savePushInstance({
        instanceToken: 'instance-token',
        relayInstanceId: 'relay-1',
        relayUrl: 'https://relay.example.invalid',
      });
      createdInstance = true;
    }
    // The route's first import is the whole of the first cell's time (4 to
    // 12 s on a busy box, the same on main; the PATCH itself 22 to 30 ms):
    // load it here, under the hook's budget, so a cell times its handler.
    await import('./route');
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from archive_client_logins where login_id = ${former}`;
    await admin`delete from push_subscriptions where owner_id = ${anchor}`;
    await admin`delete from agents where owner_id in ${admin([anchor, otherBrain])}`;
    await admin`delete from nodes where owner_id in ${admin([anchor, otherBrain])}`;
    await admin`update auth.users set contact_id = null where id in ${admin(logins)}`;
    if (deeSpace) await admin`delete from spaces where id = ${deeSpace}`;
    await admin`delete from spaces where login_id in ${admin(logins)} or id in ${admin(logins)}`;
    await admin`delete from auth.users where id in ${admin(logins)}`;
    if (createdInstance) await admin`delete from push_instance`;
    await m.closeDb();
  });

  beforeEach(() => {
    h.relayDeleted = [];
  });

  it('POST records the enrolling login, not only the brain', async () => {
    await enroll(bea, `${tag}-bea-1`);
    const [row] = await admin<Row[]>`
      select owner_id, login_id from push_subscriptions where routing_token = ${`${tag}-bea-1`}`;
    expect(row).toEqual({ owner_id: anchor, login_id: bea });
  });

  it('disabling a login removes its devices (only its), tells the relay, releases its assistant', async () => {
    await enroll(bea, `${tag}-bea-2`);
    await enroll(anchor, `${tag}-anchor-1`);
    await assign(bea, `${tag}-bea-pa`);
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    const res = await PATCH(json('PATCH', { disabled: true }), ctx(bea));
    expect(res.status).toBe(200);
    expect(await devicesOf(bea)).toEqual([]);
    expect(await devicesOf(anchor)).toEqual([`${tag}-anchor-1`]);
    expect(h.relayDeleted.sort()).toEqual([`${tag}-bea-1`, `${tag}-bea-2`]);
    // Released, not deleted: the agent is a shared agent again.
    expect(await assignedTo(`${tag}-bea-pa`)).toEqual({ assigned_user_id: null });
  });

  it('demoting a login to member does the same', async () => {
    await enroll(cal, `${tag}-cal-1`);
    await assign(cal, `${tag}-cal-pa`);
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    const res = await PATCH(json('PATCH', { role: 'member' }), ctx(cal));
    expect(res.status).toBe(200);
    expect(await devicesOf(cal)).toEqual([]);
    expect(h.relayDeleted).toEqual([`${tag}-cal-1`]);
    expect(await assignedTo(`${tag}-cal-pa`)).toEqual({ assigned_user_id: null });
    // S8b: the demotion is a removal from Admin by its definer, which wrote
    // the role in the same transaction and names the caller on its event.
    const [after] = await admin<Row[]>`
      select u.role,
             exists (select 1 from workspace_users wu join workspaces w on w.id = wu.workspace_id
                      where wu.login_id = u.id and w.is_admin and w.archived_at is null
                        and w.owner_id = mantle_brain_id()) as in_admin,
             (select count(*)::int from workspace_events e
               where e.action = 'user.remove' and e.actor_id = ${anchor}
                 and e.subject->>'login' = u.id::text) as removed
        from auth.users u where u.id = ${cal}`;
    expect(after).toEqual({ role: 'member', in_admin: false, removed: 1 });
  });

  it('a rename is not a lockout: devices and assistant stay', async () => {
    await enroll(eve, `${tag}-eve-1`);
    await assign(eve, `${tag}-eve-pa`);
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    expect((await PATCH(json('PATCH', { displayName: 'Eve' }), ctx(eve))).status).toBe(200);
    expect(await devicesOf(eve)).toEqual([`${tag}-eve-1`]);
    expect(h.relayDeleted).toEqual([]);
    expect(await assignedTo(`${tag}-eve-pa`)).toEqual({ assigned_user_id: eve });
  });

  it('deleting a login removes its devices and tells the relay', async () => {
    await enroll(dee, `${tag}-dee-1`);
    const [sp] = await admin<Row[]>`
      select id, orphaned_at from spaces where kind = 'personal' and login_id = ${dee}`;
    deeSpace = sp?.id as string;
    expect(sp?.orphaned_at).toBeNull();
    h.caller = as(anchor);
    const { DELETE } = await import('./route');
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx(dee));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await devicesOf(dee)).toEqual([]);
    expect(h.relayDeleted).toEqual([`${tag}-dee-1`]);
    // The space stays, with no login, and records when (the purge's clock).
    const [after] = await admin<
      Row[]
    >`select login_id, orphaned_at from spaces where id = ${deeSpace}`;
    expect(after?.login_id).toBeNull();
    expect(after?.orphaned_at).not.toBeNull();
    expect(after?.orphaned_at).toBeDefined();
  });

  it('the login FK cascades: a login deleted by hand takes its devices', async () => {
    await admin`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
                values (${anchor}, ${raw}, ${`${tag}-raw-1`}, 'pk', 'android')`;
    await admin`delete from spaces where login_id = ${raw}`;
    await admin`delete from auth.users where id = ${raw}`;
    const left = await admin<Row[]>`
      select 1 from push_subscriptions where routing_token = ${`${tag}-raw-1`}`;
    expect(left).toHaveLength(0);
  });

  it('a member login cannot be given a personal assistant; an admin can', async () => {
    h.caller = as(anchor);
    const { PUT } = await import('./agent/route');
    const body = { name: `${tag} helper`, sourceAgentId: ids.source };
    const refused = await PUT(json('PUT', body), ctx(cal)); // cal is a member now
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('member login');
    const [none] = await admin<Row[]>`
      select count(*)::int as n from agents where assigned_user_id = ${cal}`;
    expect(none).toEqual({ n: 0 });
    // The same source clones for an admin: the refusal was the role.
    expect((await PUT(json('PUT', { ...body, name: `${tag} eve2` }), ctx(eve))).status).toBe(200);
  });

  it('a member made admin gets their shared and submitted items back as private drafts', async () => {
    // cal is a member now (demoted above). A shared note and a submitted one.
    const [sp] = await admin<Row[]>`
      select id from spaces where kind = 'personal' and login_id = ${cal}`;
    const space = sp!.id as string;
    const shared = randomUUID();
    const submitted = randomUUID();
    const kept = randomUUID();
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${shared}, ${space}, 'note', 'shared', 'notes'),
      (${submitted}, ${space}, 'note', 'submitted', 'notes'),
      (${kept}, ${space}, 'note', 'private', 'notes')`;
    await admin`insert into space_items (node_id, author_login_id, sharing, review_state, submitted_at)
      values (${shared}, ${cal}, 'team', 'draft', null),
             (${submitted}, ${cal}, 'private', 'submitted', now()),
             (${kept}, ${cal}, 'private', 'draft', null)`;
    await admin`insert into space_item_bundles (root_id, node_id, position)
      values (${submitted}, ${submitted}, 0), (${submitted}, ${kept}, 1)`;
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    expect((await PATCH(json('PATCH', { role: 'admin' }), ctx(cal))).status).toBe(200);
    const rows = await admin<Row[]>`
      select node_id, sharing, review_state, submitted_at from space_items
       where node_id in ${admin([shared, submitted, kept])} order by node_id`;
    for (const r of rows) {
      expect(r, String(r.node_id)).toMatchObject({
        sharing: 'private',
        review_state: 'draft',
        submitted_at: null,
      });
    }
    const bundles = await admin<Row[]>`
      select 1 from space_item_bundles where root_id = ${submitted}`;
    expect(bundles).toHaveLength(0);
    await admin`delete from nodes where owner_id = ${space}`;
  });

  describe('contact links', () => {
    it('refuse a node that is not a contact, and a contact of another brain', async () => {
      h.caller = as(anchor);
      const { PATCH } = await import('./route');
      for (const contactId of [ids.notContact, ids.foreignContact]) {
        const res = await PATCH(json('PATCH', { contactId }), ctx(eve));
        expect(res.status, contactId).toBe(400);
      }
    });

    it('refuse a contact already linked to another login (409); relinking the same login is fine', async () => {
      h.caller = as(anchor);
      const { PATCH } = await import('./route');
      expect((await PATCH(json('PATCH', { contactId: ids.contact }), ctx(bea))).status).toBe(200);
      const taken = await PATCH(json('PATCH', { contactId: ids.contact }), ctx(eve));
      expect(taken.status).toBe(409);
      const [e] = await admin<Row[]>`select contact_id from auth.users where id = ${eve}`;
      expect(e).toEqual({ contact_id: null });
      expect((await PATCH(json('PATCH', { contactId: ids.contact }), ctx(bea))).status).toBe(200);
      expect((await PATCH(json('PATCH', { contactId: ids.otherContact }), ctx(eve))).status).toBe(
        200,
      );
    });
  });

  // W8a fix round 1 (L6): a former client login stays disabled.
  it('refuses to enable a former client login; an ordinary disabled login enables', async () => {
    // A member since setup (the role guard, 0330, refuses the app pool a role write).
    await admin`update auth.users set disabled_at = now() where id = ${former}`;
    await admin`insert into archive_client_logins (login_id, email, created_at, session_epoch)
      select id, email, created_at, session_epoch from auth.users where id = ${former}`;
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    const res = await PATCH(json('PATCH', { disabled: false }), ctx(former));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This was a client login. A former client login stays disabled and cannot be enabled again.',
      reason: 'former-client',
    });
    const [row] = await admin<Row[]>`
      select disabled_at is not null as disabled from auth.users where id = ${former}`;
    expect(row).toEqual({ disabled: true });
    // A rename or a sign-out is still fine; only enabling is refused.
    expect((await PATCH(json('PATCH', { signOut: true }), ctx(former))).status).toBe(200);
    // Control: a login that was never a client enables (bea, disabled above).
    expect((await PATCH(json('PATCH', { disabled: false }), ctx(bea))).status).toBe(200);
  });

  // W8a leftover, closed in W8d: another login is not linked to a former
  // client's contact (an invite or a new login on it is refused already).
  it("refuses to link another login to a former client's contact (409 contact-was-client)", async () => {
    // Runs after the test above: `former` is archived as a client.
    await admin`update archive_client_logins set contact_id = ${ids.formerContact}
                 where login_id = ${former}`;
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    const res = await PATCH(json('PATCH', { contactId: ids.formerContact }), ctx(eve));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'That contact belonged to a client login. A former client cannot be invited or given a new login.',
      reason: 'contact-was-client',
    });
    const [e] = await admin<Row[]>`select contact_id from auth.users where id = ${eve}`;
    expect(e!.contact_id).not.toBe(ids.formerContact);
    // The former client's own contact is its own: not refused for it.
    expect((await PATCH(json('PATCH', { contactId: ids.formerContact }), ctx(former))).status).toBe(
      200,
    );
    // Control: an ordinary contact still links to eve.
    expect((await PATCH(json('PATCH', { contactId: ids.otherContact }), ctx(eve))).status).toBe(
      200,
    );
  });

  // W8a: there is no client login. The role check admits admin and member
  // only, so no route here meets a third role. As the superuser: the role
  // guard (0330, a BEFORE trigger) refuses an app pool first.
  it('a login row cannot be made with the client role (0272)', async () => {
    const { superuserClient } = await import('@mantle/db/test-support');
    const su = superuserClient(URL!);
    try {
      await expect(
        su`insert into auth.users (id, email, password_hash, role)
           values (${randomUUID()}, ${`${tag}-client@example.invalid`}, 'x', 'client')`,
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await su.end();
    }
  });

  /** A login's role column, its Admin row, and the events naming it. */
  const adminState = async (id: string) =>
    (
      await admin<Row[]>`
        select u.role,
               exists (select 1 from workspace_users wu join workspaces w on w.id = wu.workspace_id
                        where wu.login_id = u.id and w.is_admin and w.archived_at is null
                          and w.owner_id = mantle_brain_id()) as in_admin,
               (select count(*)::int from workspace_events e
                 where e.action in ('user.add', 'user.remove')
                   and e.subject->>'login' = u.id::text) as events
          from auth.users u where u.id = ${id}`
    )[0];

  it('a caller without the users area: the definer refuses the role change, 403 (S8b round 4, L3)', async () => {
    h.caller = as(noU);
    const { PATCH } = await import('./route');
    const before = { fay: await adminState(fay), gus: await adminState(gus) };
    for (const [id, role] of [
      [fay, 'member'],
      [gus, 'admin'],
    ] as const) {
      const res = await PATCH(json('PATCH', { role }), ctx(id));
      expect(res.status, role).toBe(403);
      expect(await res.json(), role).toMatchObject({ reason: 'users-area' });
    }
    // Nothing moved: no row, no role, no event.
    expect({ fay: await adminState(fay), gus: await adminState(gus) }).toEqual(before);
    // The admin login create is the same refusal (POST /api/users).
    const { POST } = await import('../route');
    const made = await POST(
      json('POST', {
        email: `${tag}-nou-made@example.invalid`,
        password: 'a-long-enough-password-1',
        role: 'admin',
      }),
    );
    expect(made.status).toBe(403);
    expect(
      (
        await admin<
          Row[]
        >`select id from auth.users where email = ${`${tag}-nou-made@example.invalid`}`
      ).length,
    ).toBe(0);
  });

  it('decides from membership, so drift is put right (S8b round 4, L2)', async () => {
    h.caller = as(anchor);
    const { PATCH } = await import('./route');
    // hal: role admin, no Admin row. Made admin: membership says member, so
    // the change adds it; the definer writes the role (main: no change).
    expect(await adminState(hal)).toEqual({ role: 'admin', in_admin: false, events: 0 });
    expect((await PATCH(json('PATCH', { role: 'admin' }), ctx(hal))).status).toBe(200);
    expect(await adminState(hal)).toEqual({ role: 'admin', in_admin: true, events: 1 });
    // ivy: role member, an Admin row. Made member: membership says admin,
    // so the change removes it (main: no change, the row stayed).
    expect(await adminState(ivy)).toEqual({ role: 'member', in_admin: true, events: 0 });
    expect((await PATCH(json('PATCH', { role: 'member' }), ctx(ivy))).status).toBe(200);
    expect(await adminState(ivy)).toEqual({ role: 'member', in_admin: false, events: 1 });
    // Again: membership already says member, nothing moves.
    expect((await PATCH(json('PATCH', { role: 'member' }), ctx(ivy))).status).toBe(200);
    expect(await adminState(ivy)).toEqual({ role: 'member', in_admin: false, events: 1 });
  });
});

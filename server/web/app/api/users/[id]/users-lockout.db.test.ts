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
 *     private drafts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run 'server/web/app/api/users/[id]/users-lockout.db.test.ts'
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  caller: null as unknown,
  relayDeleted: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.caller),
  getOwnerOr401WithSource: vi.fn(async () => ({ user: h.caller, source: 'web' })),
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
  const cli = randomUUID(); // a client login (client logins C0)
  const logins = [anchor, otherBrain, bea, cal, dee, eve, raw, cli];
  const ids = {
    contact: randomUUID(),
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
  const enroll = async (loginId: string, token: string) => {
    h.caller = as(loginId);
    const { POST } = await import('../../push/subscriptions/route');
    const res = await POST(
      new Request('http://x/api/push/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    for (const id of logins) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x',
                          ${id === cli ? 'client' : 'admin'})`;
    }
    // Items belong to a space (0165): each test brain is a brain row.
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${otherBrain}, 'brain', ${otherBrain})`;
    await admin`insert into nodes (id, owner_id, type, title, path) values
      (${ids.contact}, ${anchor}, 'contact', 'Pat', 'contacts'),
      (${ids.otherContact}, ${anchor}, 'contact', 'Sam', 'contacts'),
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
  });

  afterAll(async () => {
    if (!admin) return;
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

  // Client logins C0: routes about a login name the roles they serve, so a
  // client is never treated as an admin or a member here.
  describe('a client login (C0)', () => {
    const roleOf = async (id: string) =>
      (await admin<Row[]>`select role, password_hash from auth.users where id = ${id}`)[0];

    it('cannot change role, to member or to admin', async () => {
      h.caller = as(anchor);
      const { PATCH } = await import('./route');
      for (const role of ['member', 'admin']) {
        const res = await PATCH(json('PATCH', { role }), ctx(cli));
        expect(res.status, role).toBe(400);
      }
      expect(await roleOf(cli)).toMatchObject({ role: 'client' });
      // Disabling it is fine (and is how a client login ends).
      expect((await PATCH(json('PATCH', { disabled: true }), ctx(cli))).status).toBe(200);
      expect((await PATCH(json('PATCH', { disabled: false }), ctx(cli))).status).toBe(200);
    });

    it('cannot be given a personal assistant', async () => {
      h.caller = as(anchor);
      const { PUT } = await import('./agent/route');
      const res = await PUT(
        json('PUT', { name: `${tag} client helper`, sourceAgentId: ids.source }),
        ctx(cli),
      );
      expect(res.status).toBe(400);
      const [none] = await admin<Row[]>`
        select count(*)::int as n from agents where assigned_user_id = ${cli}`;
      expect(none).toEqual({ n: 0 });
    });

    it('never signs in with a password, even the right one', async () => {
      const auth = await import('@/lib/auth');
      const hash = await auth.hashLoginPassword('client-password-1');
      await admin`update auth.users set password_hash = ${hash} where id in (${cli}, ${eve})`;
      const email = (id: string) => `${tag}-${id.slice(0, 8)}@example.invalid`;
      expect(await auth.authenticatePassword(email(cli), 'client-password-1')).toBeNull();
      // The same hash on an admin signs in: the refusal was the role.
      expect(await auth.authenticatePassword(email(eve), 'client-password-1')).toMatchObject({
        id: eve,
      });
      await admin`update auth.users set password_hash = 'x' where id in (${cli}, ${eve})`;
    });

    it('gets no password from an admin', async () => {
      h.caller = as(anchor);
      const { POST } = await import('./password/route');
      const res = await POST(json('POST', { newPassword: 'long-enough-pw' }), ctx(cli));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: 'not-a-password-login' });
      expect(await roleOf(cli)).toMatchObject({ password_hash: 'x' });
    });
  });
});

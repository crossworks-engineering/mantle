/**
 * The Control Center broadcast through the real app (createApp: the gate,
 * the route policies) on a real migrated Postgres (docs/control-center.md
 * "Broadcast", docs/messenger.md "Announcements"). One database plays both
 * sides, as in control.db.test.ts: the CC rows and the box.
 *
 *  - the box: the signed `broadcast` case makes the Announcements group
 *    once (no admin), every live login a member, one line per broadcast id
 *    (a second call writes nothing), a bad call refused;
 *  - members send nothing there, nor leave (a system line), and a login made
 *    later joins on its own list read; the views say `announcements`;
 *  - the CC: POST /api/fleet/broadcasts stores it once; the run delivers it;
 *    a box that is down keeps its failure code and gets it on a later run;
 *    GET lists the marks; bad text and unknown boxes are 400; off a CC, 404.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/broadcast.db.test.ts
 */
import { generateKeyPairSync, randomUUID, createPublicKey, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';
import { publicKeyLine, signCall } from './sign';

type Egress = (
  input: unknown,
  init?: RequestInit,
  opts?: Record<string, unknown>,
) => Promise<Response>;
const egress = vi.hoisted(() => ({ handle: null as null | Egress }));
vi.mock('@mantle/std/egress', async (orig) => ({
  ...(await orig<typeof import('@mantle/std/egress')>()),
  egressFetch: (input: unknown, init?: RequestInit, opts?: Record<string, unknown>) =>
    egress.handle!(input, init, opts),
}));
// facts reads box_status (pinned in its own tests): a fixed status here.
vi.mock('../box-status', async (orig) => ({
  ...(await orig<typeof import('../box-status')>()),
  boxStatus: () =>
    Promise.resolve({
      schema: 1,
      ts: new Date().toISOString(),
      build: { version: '0.0.0' },
      degraded: [],
    }),
}));

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BOX = 'https://brain.example.invalid';
const TWO = 'https://two.example.invalid';

describe.skipIf(!URL_)('the Control Center broadcast through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let key: KeyObject;
  let anchor = '';
  const tag = `bc-${randomUUID().slice(0, 8)}`;
  const pat = randomUUID(); // a member
  const boss = randomUUID(); // an Admin user
  const off = randomUUID(); // a disabled login
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  /** The box origins that do not answer (the network fails). */
  const down = new Set<string>();
  let ip = 0;

  const signed = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    return Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...signCall(key, BOX, body),
        },
      }),
    );
  };
  const group = async () =>
    (
      await sql<Row[]>`select id::text as id, title, announcements, archived_at
        from messenger_conversations where owner_id = ${anchor} and announcements`
    )[0];
  const lines = (id: string) =>
    sql<Row[]>`select author_kind, author_name, body, event from messenger_messages
      where conversation_id = ${id} order by seq`;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'broadcast-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = `${BOX}/`;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    m = await import('@mantle/db');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${pat}, ${emailOf(pat)}, '', 'member'),
      (${boss}, ${emailOf(boss)}, '', 'admin')`;
    await sql`insert into auth.users (id, email, password_hash, role, disabled_at) values
      (${off}, ${emailOf(off)}, '', 'member', now())`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql as never, [boss]);
    key = generateKeyPairSync('ed25519').privateKey;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(createPublicKey(key));
    const { createApp } = await import('../../server/app');
    app = await createApp();
    // The run's call reaches the app in this process. A box in `down`
    // does not answer. TWO is this same box under another origin: the box
    // checks the signature against MANTLE_PUBLIC_URL, set to the origin
    // called while the call runs, one call at a time (the run's lanes run
    // boxes side by side).
    let chain: Promise<unknown> = Promise.resolve();
    egress.handle = (input, init) => {
      const call = async () => {
        const url = new URL(String(input));
        if (down.has(url.origin)) throw new Error('connect refused');
        const h = new Headers(init?.headers);
        h.set('x-forwarded-for', `203.0.113.${(ip += 1) % 250}`);
        h.set('x-forwarded-proto', 'https');
        process.env.MANTLE_PUBLIC_URL = `${url.origin}/`;
        // A CC is never a subject: the box side runs with the flag off.
        const ccFlag = process.env.MANTLE_IS_CONTROL_CENTER;
        delete process.env.MANTLE_IS_CONTROL_CENTER;
        try {
          return await app.request(url.pathname, {
            method: init?.method,
            headers: h,
            body: init?.body as BodyInit,
          });
        } finally {
          process.env.MANTLE_PUBLIC_URL = `${BOX}/`;
          if (ccFlag !== undefined) process.env.MANTLE_IS_CONTROL_CENTER = ccFlag;
        }
      };
      const next = chain.then(call, call);
      chain = next.catch(() => undefined);
      return next;
    };
  }, 120_000);

  afterAll(async () => {
    delete process.env.MANTLE_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER_KEY;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_PUBLIC_URL;
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the box: Announcements made once, every live login in it, one line per broadcast id', async () => {
    const id = randomUUID();
    const call = {
      op: 'broadcast',
      args: { id, title: 'Maintenance', body: 'The boxes restart at 22:00.', by: 'it@example.com' },
    };
    const first = await signed(call);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ kind: 'broadcast', ok: true, was: 'new' });
    // The same id again: nothing new.
    expect(await (await signed(call)).json()).toEqual({
      kind: 'broadcast',
      ok: true,
      was: 'already',
    });
    const g = await group();
    expect(g).toMatchObject({ title: 'Announcements', announcements: true, archived_at: null });
    const people = await sql<Row[]>`select login_id::text as login_id, admin
      from messenger_participants where conversation_id = ${String(g!.id)} and kind = 'login'`;
    expect(people.map((p) => p.login_id).sort()).toEqual([anchor, pat, boss].sort());
    expect(people.every((p) => p.admin === false)).toBe(true);
    const got = await lines(String(g!.id));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      author_kind: 'system',
      author_name: 'it@example.com',
      body: 'Maintenance\n\nThe boxes restart at 22:00.',
      event: { type: 'announcement', broadcastId: id, title: 'Maintenance' },
    });
    // A second broadcast goes in the same group; no title, the text alone.
    const second = await signed({
      op: 'broadcast',
      args: { id: randomUUID(), title: '', body: 'Done.', by: 'it@example.com' },
    });
    expect((await second.json()) as Row).toMatchObject({ was: 'new' });
    expect((await lines(String(g!.id))).map((l) => l.body)).toEqual([
      'Maintenance\n\nThe boxes restart at 22:00.',
      'Done.',
    ]);
    const groups = await sql<Row[]>`select count(*)::int as n from messenger_conversations
      where owner_id = ${anchor} and announcements`;
    expect(groups[0]!.n).toBe(1);
    // A bad call: no text, or a field the case does not take.
    const blank = await signed({
      op: 'broadcast',
      args: { id: randomUUID(), title: '', body: '  ', by: 'x' },
    });
    expect([blank.status, ((await blank.json()) as Row).reason]).toEqual([400, 'bad-call']);
    const extra = await signed({
      op: 'broadcast',
      args: { id: randomUUID(), title: '', body: 'x', by: 'x', to: 'all' },
    });
    expect(extra.status).toBe(400);
    // The box's audit row names the broadcast (written after the answer).
    await vi.waitFor(async () => {
      const audit = await sql<Row[]>`select detail from audit_log
        where actor_email = 'control-center' and detail ->> 'op' = 'broadcast'`;
      expect(audit.some((a) => (a.detail as Row).broadcastId === id)).toBe(true);
    });
  });

  it('members send nothing there and cannot leave; a login made later joins on its list', async () => {
    const ms = await import('@mantle/content/messenger');
    const g = await group();
    const as = (loginId: string) => ({ ownerId: anchor, loginId, via: null });
    await expect(
      ms.sendMessengerMessage(as(pat), String(g!.id), { body: 'thanks!' }),
    ).rejects.toThrow(ms.ANNOUNCEMENTS_READ_ONLY);
    await expect(
      ms.sendMessengerMessage(as(boss), String(g!.id), { body: 'me too', replyToSeq: 1 }),
    ).rejects.toThrow(/read-only/);
    await expect(ms.leaveMessengerConversation(as(pat), String(g!.id))).rejects.toThrow(
      /read-only/,
    );
    // No admin: a rename, an add or a handle is refused.
    await expect(
      ms.patchMessengerConversation(as(boss), String(g!.id), { title: 'Mine now' }),
    ).rejects.toThrow(/admin/);
    // A mute is the member's own.
    await ms.patchMessengerConversation(as(pat), String(g!.id), { muted: true });
    const view = await ms.getMessengerConversation(as(pat), String(g!.id));
    expect(view).toMatchObject({ announcements: true, me: { muted: true, admin: false } });
    // A login made after the broadcasts: in the group on its first list,
    // reading it from the start.
    const late = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role)
      values (${late}, ${emailOf(late)}, '', 'member')`;
    const rows = await ms.listMessengerConversations(as(late));
    const row = rows.find((r) => r.id === g!.id);
    expect(row).toMatchObject({ announcements: true, title: 'Announcements', unread: 2 });
    // A plain group is not Announcements.
    const { conversationId } = await ms.createMessengerConversation(as(pat), {
      kind: 'group',
      participants: [],
      title: `${tag} plain`,
    });
    expect((await ms.getMessengerConversation(as(pat), conversationId)).announcements).toBe(false);
  });

  it('the CC: one store, the run delivers, a box that is down gets it later', async () => {
    const tokens = await import('../auth/tokens');
    const [e] = await sql<Row[]>`select session_epoch from auth.users where id = ${boss}`;
    const cookie = `mantle_session=${
      tokens.buildSessionCookie(boss, { epoch: Number(e!.session_epoch), ttlSeconds: 3600 }).value
    }`;
    const fleet = (method: string, body?: unknown) =>
      Promise.resolve(
        app.request('/api/fleet/broadcasts', {
          method,
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-forwarded-for': `192.0.2.${(ip += 1) % 250}`,
            'x-forwarded-proto': 'https',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    // Off a CC: 404.
    expect((await fleet('GET')).status).toBe(404);
    expect((await fleet('POST', { text: 'x' })).status).toBe(404);
    process.env.MANTLE_IS_CONTROL_CENTER = 'on';
    try {
      const cc = await import('@mantle/db/control-center');
      const run = await import('./run');
      const one = (await cc.addControlBox(BOX, 'box one', 'test'))!;
      const two = (await cc.addControlBox(TWO, 'box two', 'test'))!;
      // Bad text, a title too long, an unknown box: 400, nothing stored.
      expect((await fleet('POST', { text: '   ' })).status).toBe(400);
      expect((await fleet('POST', { text: 'x', title: 'y'.repeat(201) })).status).toBe(400);
      expect((await fleet('POST', { text: 'x', boxIds: [randomUUID()] })).status).toBe(400);
      expect((await cc.listControlBroadcasts()).length).toBe(0);

      down.add(TWO);
      const res = await fleet('POST', { title: 'Hello', text: 'One message for all.' });
      expect(res.status).toBe(200);
      const made = ((await res.json()) as { broadcast: Row }).broadcast;
      expect((made.boxIds as string[]).sort()).toEqual([one.id, two.id].sort());
      expect(made.madeBy).toBe(emailOf(boss));
      await run.runDueBoxes(key);
      let [b] = await cc.listControlBroadcasts();
      expect(b!.marks[one.id]).toMatchObject({ was: 'new', at: expect.any(String) });
      expect(b!.marks[two.id]).toMatchObject({ reason: 'unreachable', tried: expect.any(String) });
      // Once on the box.
      const g = await group();
      expect(
        (await lines(String(g!.id))).filter(
          (l) => (l.event as Row | null)?.broadcastId === made.id,
        ),
      ).toHaveLength(1);
      // Still down at the next run: the code stays, nothing dropped.
      await cc.requestControlRun();
      await run.runDueBoxes(key);
      [b] = await cc.listControlBroadcasts();
      expect(b!.marks[two.id]).toMatchObject({ reason: 'unreachable' });
      expect(b!.marks[one.id]).toMatchObject({ was: 'new' });
      // Up again: it gets it (this same box, so its line is there already).
      down.delete(TWO);
      await cc.requestControlRun();
      await run.runDueBoxes(key);
      [b] = await cc.listControlBroadcasts();
      expect(b!.marks[two.id]).toMatchObject({ was: 'already', at: expect.any(String) });
      expect(await cc.takeControlBroadcastsFor(two.id)).toEqual([]);
      // A box named alone: only it.
      const only = await fleet('POST', { text: 'Just box one.', boxIds: [one.id] });
      expect(((await only.json()) as { broadcast: Row }).broadcast.boxIds).toEqual([one.id]);
      // GET: the broadcasts newest first with their marks, and the boxes.
      const listed = (await (await fleet('GET')).json()) as {
        broadcasts: Row[];
        boxes: Row[];
      };
      expect(listed.broadcasts.map((x) => x.body)).toEqual([
        'Just box one.',
        'One message for all.',
      ]);
      expect(listed.boxes.map((x) => x.id).sort()).toEqual([one.id, two.id].sort());
    } finally {
      delete process.env.MANTLE_IS_CONTROL_CENTER;
    }
  });
});

/**
 * The call store (calls plan page 886126b4, section 13 "Server"), on a
 * migrated scratch brain with a stand-in LiveKit:
 *
 *  - the token route's rules: a non-participant hears "not found", a leaver
 *    is refused, a live participant gets a token for the one room with the
 *    ICE override; a second device swaps the first; calls off is one 404;
 *  - call rows: one open call per conversation, start then join makes no
 *    second row, the "call started" line takes the next seq and fires
 *    messenger_changed; the head-count cap;
 *  - the webhook: a replayed id is a no-op; joined, left and room_finished
 *    write the stays and close the row with the ended line and its seconds;
 *  - the reconciler: a gone room closes as reconciled, a row past the cap
 *    as cap_reached with the room deleted, a service-off pass closes all,
 *    an unreachable LiveKit closes nothing, stays are corrected;
 *  - admin acts: end, remove; the agent stub refuses and records nothing;
 *  - row security: a call row reads as its "call started" line;
 *  - the assistant twin.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/messenger-calls.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LivekitClient, LivekitParticipantInfo, LivekitRoomInfo } from './livekit';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** A LiveKit that remembers its rooms and what the brain asked of it. */
function fakeLivekit() {
  const rooms = new Map<string, LivekitRoomInfo & { participants: LivekitParticipantInfo[] }>();
  const calls: { op: string; room: string; identity?: string }[] = [];
  let unreachable = false;
  const client: LivekitClient = {
    async ensureRoom(name, opts) {
      calls.push({ op: 'ensureRoom', room: name });
      if (unreachable) throw new (await import('./livekit')).LivekitUnavailableError();
      let r = rooms.get(name);
      if (!r) {
        r = {
          name,
          sid: `RM_${name}`,
          turnPassword: `pw-${name}`,
          numParticipants: 0,
          participants: [],
        };
        rooms.set(name, r);
      }
      void opts;
      return {
        name: r.name,
        sid: r.sid,
        turnPassword: r.turnPassword,
        numParticipants: r.participants.length,
      };
    },
    async getRoom(name) {
      calls.push({ op: 'getRoom', room: name });
      if (unreachable) throw new (await import('./livekit')).LivekitUnavailableError();
      const r = rooms.get(name);
      return r
        ? {
            name: r.name,
            sid: r.sid,
            turnPassword: r.turnPassword,
            numParticipants: r.participants.length,
          }
        : null;
    },
    async listParticipants(name) {
      calls.push({ op: 'listParticipants', room: name });
      if (unreachable) throw new (await import('./livekit')).LivekitUnavailableError();
      const r = rooms.get(name);
      return r ? [...r.participants] : null;
    },
    async removeParticipant(name, identity) {
      calls.push({ op: 'removeParticipant', room: name, identity });
      if (unreachable) throw new (await import('./livekit')).LivekitUnavailableError();
      const r = rooms.get(name);
      if (r) r.participants = r.participants.filter((p) => p.identity !== identity);
    },
    async deleteRoom(name) {
      calls.push({ op: 'deleteRoom', room: name });
      if (unreachable) throw new (await import('./livekit')).LivekitUnavailableError();
      rooms.delete(name);
    },
  };
  return {
    client,
    rooms,
    calls,
    setUnreachable(v: boolean) {
      unreachable = v;
    },
    join(room: string, identity: string) {
      const r = rooms.get(room);
      if (!r) throw new Error(`no room ${room}`);
      r.participants.push({ identity, name: identity, joinedAt: Math.floor(Date.now() / 1000) });
    },
    leave(room: string, identity: string) {
      const r = rooms.get(room);
      if (r) r.participants = r.participants.filter((p) => p.identity !== identity);
    },
  };
}

describe.skipIf(!URL)('the call store (calls P1 M1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
  let mc: typeof import('./messenger-calls');
  let lk: typeof import('./livekit');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  let pool: {
    listen: (c: string, cb: (p: string) => void) => Promise<{ unlisten: () => Promise<void> }>;
  };
  const fake = fakeLivekit();

  const tag = `mc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const W = randomUUID();
  const agent = randomUUID();
  const changed: { c: string; seq: number | null; kind: string }[] = [];
  const unlistens: (() => Promise<void>)[] = [];

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  const as = <T>(loginId: string, fn: () => Promise<T>) => m.withViewer({ login: loginId }, fn);
  const raw = async (loginId: string, table: string, where: string) =>
    as(loginId, async () => {
      const rows = (await m.db.execute(
        sqlTag.raw(`select * from ${table} where ${where}`),
      )) as unknown as Record<string, unknown>[];
      return rows;
    });
  const decode = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
  const openCall = async (c: string) =>
    (await su(sqlTag`select id::text as id, room_name, started_seq::int as started_seq, max_participants
                       from messenger_calls where conversation_id = ${c} and ended_at is null`)) as {
      id: string;
      room_name: string;
      started_seq: number;
      max_participants: number;
    }[];
  const stays = async (callId: string) =>
    (await su(sqlTag`select kind, login_id::text as login_id, device, (left_at is null) as open
                       from messenger_call_participants where call_id = ${callId} order by joined_at`)) as {
      kind: string;
      login_id: string | null;
      device: string | null;
      open: boolean;
    }[];
  const lastLine = async (c: string) =>
    (await su(sqlTag`select seq::int as seq, author_kind, body, event from messenger_messages
                       where conversation_id = ${c} order by seq desc limit 1`)) as {
      seq: number;
      author_kind: string;
      body: string;
      event: Record<string, unknown> | null;
    }[];
  const webhook = (event: string, room: string, identity?: string, id = `EV_${randomUUID()}`) => ({
    id,
    event,
    roomName: room,
    participant: identity ? { identity, name: identity } : null,
    createdAt: Math.floor(Date.now() / 1000),
  });

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_LIVEKIT_API_KEY = 'APItest';
    process.env.MANTLE_LIVEKIT_API_SECRET = 'a-secret-long-enough-for-the-sdk-to-accept-it';
    process.env.MANTLE_LIVEKIT_URL = 'ws://livekit:7880';
    process.env.MANTLE_CALLS_HOST = 'brain.example.test';
    process.env.MANTLE_UPDATE_SIGNAL_DIR = '/nonexistent-signal-dir';
    process.env.MANTLE_COMPOSE_PROFILES = 'calls';
    delete process.env.MANTLE_CALLS_AGENT;
    delete process.env.MANTLE_CALLS_MAX_PARTICIPANTS;
    m = await import('@mantle/db');
    ms = await import('./messenger');
    mc = await import('./messenger-calls');
    lk = await import('./livekit');
    lk.setLivekitClientForTests(fake.client);
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    pool = (m.systemDb as unknown as { $client: typeof pool }).$client;
    unlistens.push(
      (await pool.listen('messenger_changed', (p) => changed.push(JSON.parse(p)))).unlisten,
    );

    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat'),
      (${D}, ${`${tag}-d@example.invalid`}, 'x', 'member', 'Dan')`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C}, ${D})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${C}), (${W}, ${D})`);
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agent}, ${owner}, ${`${tag}-tess`}, 'Tess', 'test/model', 'x', 'assistant', ${W})`);
    await su(sqlTag`insert into workspace_resources (workspace_id, type, ref_id)
      values (${W}, 'assistant', ${agent})`);
  }, 180_000);

  beforeEach(() => {
    ms?.resetMessengerBudgetsForTests();
    mc?.resetCallReconcileForTests();
    fake.calls.length = 0;
    fake.setUnreachable(false);
    process.env.MANTLE_COMPOSE_PROFILES = 'calls';
    delete process.env.MANTLE_CALLS_MAX_PARTICIPANTS;
    delete process.env.MANTLE_CALLS_AGENT;
  });

  afterAll(async () => {
    lk?.setLivekitClientForTests(null);
    for (const u of unlistens) await u().catch(() => {});
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 20));
  };

  // ── Start, join, the rules ─────────────────────────────────────────────

  it('a start opens one call with the "call started" line at the next seq (and its NOTIFY); a join makes no second row', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [B],
    });
    await ms.sendMessengerMessage(actor(A), c, { body: 'hello' });
    changed.length = 0;
    const join = await mc.startOrJoinCall(actor(A), c, { device: 'web' });
    expect(join.room).toBe(`msgr-${c}`);
    expect(join.url).toBe('wss://brain.example.test/livekit');
    expect(join.ice).toEqual({
      urls: [
        'turns:brain.example.test:5349?transport=tcp',
        'turn:brain.example.test:3478?transport=udp',
      ],
      username: `msgr-${c}`,
      credential: `pw-msgr-${c}`,
    });
    const claims = decode(join.token);
    expect(claims.sub).toBe(`login:${A}`);
    expect(claims.name).toBe('Ann');
    expect((claims.video as { room: string }).room).toBe(`msgr-${c}`);
    expect(Object.keys(claims.video as object).sort()).toEqual(
      [
        'canPublish',
        'canPublishData',
        'canPublishSources',
        'canSubscribe',
        'room',
        'roomJoin',
      ].sort(),
    );
    const [row] = await openCall(c);
    expect(row).toBeTruthy();
    expect(row!.id).toBe(join.callId);
    const [line] = await lastLine(c);
    expect(line).toEqual({
      seq: 2,
      author_kind: 'system',
      body: 'Ann started a call.',
      event: { type: 'call_started', callId: join.callId },
    });
    expect(row!.started_seq).toBe(2);
    await waitFor(() => changed.some((x) => x.c === c && x.seq === 2 && x.kind === 'new'));
    expect(changed.some((x) => x.c === c && x.seq === 2 && x.kind === 'new')).toBe(true);
    // The stay opened with the tap, from the device named.
    expect(await stays(join.callId!)).toEqual([
      { kind: 'login', login_id: A, device: 'web', open: true },
    ]);
    // The room was made before the row, with the plan's limits; the earlier
    // device of A was dropped by identity before the token was handed out.
    expect(fake.calls.map((x) => x.op)).toEqual(['ensureRoom', 'removeParticipant']);

    // A join: the same call, a token for B, no second row, no second line.
    const joinB = await mc.startOrJoinCall(actor(B), c, {});
    expect(joinB.callId).toBe(join.callId);
    expect(decode(joinB.token).sub).toBe(`login:${B}`);
    expect((await openCall(c)).length).toBe(1);
    expect((await lastLine(c))[0]!.seq).toBe(2);
    expect((await stays(join.callId!)).length).toBe(2);

    // One open call per conversation is the index, not only the module.
    await expect(
      su(sqlTag`insert into messenger_calls (conversation_id, room_name, started_seq)
                values (${c}, ${`msgr-${c}`}, 2)`),
    ).rejects.toThrow();

    // A refresh: the same room and call, no device swap.
    fake.calls.length = 0;
    const again = await mc.refreshCallToken(actor(B), c);
    expect(again.callId).toBe(join.callId);
    expect(again.ice?.credential).toBe(`pw-msgr-${c}`);
    expect(fake.calls.map((x) => x.op)).toEqual(['getRoom']);
  });

  it('an outsider hears "not found", a leaver is refused, calls off is one 404; nothing is written for any of them', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, D],
      title: 'Room',
    });
    await ms.leaveMessengerConversation(actor(D), g);
    await expect(mc.startOrJoinCall(actor(C), g)).rejects.toThrow(ms.MessengerNotFoundError);
    await expect(mc.startOrJoinCall(actor(D), g)).rejects.toThrow(ms.MessengerRefusedError);
    await expect(mc.refreshCallToken(actor(C), g)).rejects.toThrow(ms.MessengerNotFoundError);
    await expect(mc.listCalls(actor(C), g)).rejects.toThrow(ms.MessengerNotFoundError);
    expect(fake.calls).toEqual([]);
    expect(await openCall(g)).toEqual([]);
    process.env.MANTLE_COMPOSE_PROFILES = '';
    await expect(mc.startOrJoinCall(actor(A), g)).rejects.toThrow(mc.MessengerCallsOffError);
    expect(await openCall(g)).toEqual([]);
    expect(lk.callCapabilities().calls).toBe(false);
    // A refresh with no open call: "not found", not a new call.
    process.env.MANTLE_COMPOSE_PROFILES = 'calls';
    await expect(mc.refreshCallToken(actor(A), g)).rejects.toThrow(ms.MessengerNotFoundError);
    // LiveKit down: the tap is refused and nothing is written.
    fake.setUnreachable(true);
    await expect(mc.startOrJoinCall(actor(A), g)).rejects.toThrow(lk.LivekitUnavailableError);
    expect(await openCall(g)).toEqual([]);
  });

  it('a second device swaps the first, a join elsewhere leaves the earlier call; a full call refuses', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, C],
      title: 'Room 2',
    });
    const { conversationId: g2 } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
      title: 'Room 3',
    });
    const first = await mc.startOrJoinCall(actor(A), g, { device: 'web' });
    fake.calls.length = 0;
    const second = await mc.startOrJoinCall(actor(A), g, { device: 'desktop' });
    expect(second.callId).toBe(first.callId);
    expect(fake.calls).toContainEqual({
      op: 'removeParticipant',
      room: `msgr-${g}`,
      identity: `login:${A}`,
    });
    expect(await stays(first.callId!)).toEqual([
      { kind: 'login', login_id: A, device: 'desktop', open: true },
    ]);
    // A joins the other group's call: dropped from the first room, the stay closed.
    fake.calls.length = 0;
    const other = await mc.startOrJoinCall(actor(A), g2);
    expect(other.callId).not.toBe(first.callId);
    expect(fake.calls).toContainEqual({
      op: 'removeParticipant',
      room: `msgr-${g}`,
      identity: `login:${A}`,
    });
    expect((await stays(first.callId!))[0]!.open).toBe(false);
    // The head-count cap.
    process.env.MANTLE_CALLS_MAX_PARTICIPANTS = '2';
    await mc.startOrJoinCall(actor(B), g);
    await mc.startOrJoinCall(actor(A), g);
    await expect(mc.startOrJoinCall(actor(C), g)).rejects.toThrow(mc.MessengerCallFullError);
    // One already in keeps its place past the cap (a refresh or a swap).
    await mc.startOrJoinCall(actor(A), g, { device: 'phone' });
  });

  // ── The webhook ────────────────────────────────────────────────────────

  it('the webhook writes the stays, closes the call on room_finished with the ended line, and replays as a no-op', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [C],
    });
    const join = await mc.startOrJoinCall(actor(A), c);
    const room = `msgr-${c}`;
    // Joined: idempotent on the stay the tap opened; a new login gets one.
    expect(await mc.applyCallWebhook(webhook('participant_joined', room, `login:${A}`))).toBe(
      'applied',
    );
    expect(await mc.applyCallWebhook(webhook('participant_joined', room, `login:${C}`))).toBe(
      'applied',
    );
    expect((await stays(join.callId!)).map((s) => [s.login_id, s.open])).toEqual([
      [A, true],
      [C, true],
    ]);
    expect((await openCall(c))[0]!.max_participants).toBe(2);
    // A replay of the same id changes nothing.
    const left = webhook('participant_left', room, `login:${C}`, 'EV_left_once');
    expect(await mc.applyCallWebhook(left)).toBe('applied');
    expect((await stays(join.callId!)).map((s) => s.open)).toEqual([true, false]);
    expect(await mc.applyCallWebhook(left)).toBe('duplicate');
    // Unknown rooms and foreign kinds are ignored, their id kept.
    expect(
      await mc.applyCallWebhook(
        webhook('room_finished', 'msgr-00000000-0000-4000-8000-000000000000'),
      ),
    ).toBe('ignored');
    expect(await mc.applyCallWebhook(webhook('room_finished', `asst-${agent}-${A}`))).toBe(
      'ignored',
    );
    expect(await mc.applyCallWebhook(webhook('track_published', room, `login:${A}`))).toBe(
      'ignored',
    );
    expect(await mc.applyCallWebhook(webhook('participant_joined', room, 'stranger'))).toBe(
      'ignored',
    );
    // The row's start is moved back so the seconds are measurable.
    await su(
      sqlTag`update messenger_calls set started_at = now() - interval '90 seconds' where id = ${join.callId}`,
    );
    changed.length = 0;
    expect(await mc.applyCallWebhook(webhook('room_finished', room))).toBe('applied');
    expect(await openCall(c)).toEqual([]);
    const [closed] = (await su(
      sqlTag`select ended_reason, duration_s, max_participants from messenger_calls where id = ${join.callId}`,
    )) as { ended_reason: string; duration_s: number; max_participants: number }[];
    expect(closed!.ended_reason).toBe('finished');
    expect(closed!.duration_s).toBeGreaterThanOrEqual(89);
    expect(closed!.duration_s).toBeLessThanOrEqual(95);
    expect((await stays(join.callId!)).every((s) => !s.open)).toBe(true);
    const [line] = await lastLine(c);
    expect(line!.author_kind).toBe('system');
    expect(line!.body).toBe('Call ended (2 min, 2 people).');
    expect(line!.event).toMatchObject({ type: 'call_ended', callId: join.callId, participants: 2 });
    expect((line!.event as { seconds: number }).seconds).toBe(closed!.duration_s);
    await waitFor(() => changed.some((x) => x.c === c && x.seq === line!.seq && x.kind === 'new'));
    expect(changed.some((x) => x.c === c && x.seq === line!.seq && x.kind === 'new')).toBe(true);
    // A late webhook for the closed room is ignored; the chat can start again.
    expect(await mc.applyCallWebhook(webhook('participant_left', room, `login:${A}`))).toBe(
      'ignored',
    );
    const next = await mc.startOrJoinCall(actor(C), c);
    expect(next.callId).not.toBe(join.callId);
  });

  // ── The reconciler ─────────────────────────────────────────────────────

  it('the reconciler closes a gone room as reconciled, a row past the cap as cap_reached (room deleted), corrects stays, and closes nothing when LiveKit is down', async () => {
    // The calls the tests above left open: closed first, so the counts
    // below are this test's alone.
    await mc.reconcileCalls({ serviceOn: false });
    expect(await su(sqlTag`select 1 from messenger_calls where ended_at is null`)).toEqual([]);
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, C, D],
      title: 'Room 4',
    });
    const { conversationId: g2 } = await ms.createMessengerConversation(actor(B), {
      kind: 'group',
      participants: [C],
      title: 'Room 5',
    });
    const { conversationId: g3 } = await ms.createMessengerConversation(actor(C), {
      kind: 'group',
      participants: [D],
      title: 'Room 6',
    });
    const live = await mc.startOrJoinCall(actor(A), g);
    const gone = await mc.startOrJoinCall(actor(B), g2);
    const old = await mc.startOrJoinCall(actor(C), g3);
    // The live room: D is in it without a stay, A's stay is open but A is
    // not in the room.
    fake.join(`msgr-${g}`, `login:${D}`);
    fake.join(`msgr-${g}`, 'mantle-voice');
    fake.rooms.delete(`msgr-${g2}`);
    await su(
      sqlTag`update messenger_calls set started_at = now() - interval '5 hours' where id = ${old.callId}`,
    );

    fake.setUnreachable(true);
    const down = await mc.reconcileCalls();
    expect(down.unreachable).toBe(true);
    expect(down.closed).toEqual({ reconciled: 0, cap_reached: 0, service_off: 0 });
    expect((await openCall(g)).length + (await openCall(g2)).length).toBe(2);
    fake.setUnreachable(false);

    fake.calls.length = 0;
    const r = await mc.reconcileCalls();
    expect(r.open).toBe(3);
    expect(r.closed).toEqual({ reconciled: 1, cap_reached: 1, service_off: 0 });
    expect(r.corrected).toBe(2);
    expect(fake.calls).toContainEqual({ op: 'deleteRoom', room: `msgr-${g3}` });
    expect(await openCall(g2)).toEqual([]);
    expect(await openCall(g3)).toEqual([]);
    expect((await lastLine(g2))[0]!.event).toMatchObject({
      type: 'call_ended',
      callId: gone.callId,
    });
    const [capLine] = await lastLine(g3);
    expect(capLine!.body).toBe('Call ended: the 240-minute limit was reached.');
    expect(capLine!.event).toMatchObject({ type: 'call_cap', callId: old.callId });
    expect((capLine!.event as { seconds: number }).seconds).toBeGreaterThanOrEqual(5 * 3600 - 5);
    const [reasons] = (await su(
      sqlTag`select string_agg(ended_reason, ',' order by ended_reason) as r from messenger_calls where id in (${gone.callId}, ${old.callId})`,
    )) as { r: string }[];
    expect(reasons!.r).toBe('cap_reached,reconciled');
    // The live call: A's stay closed, D's opened; the room's stranger ignored.
    expect((await stays(live.callId!)).map((s) => [s.login_id, s.open])).toEqual([
      [A, false],
      [D, true],
    ]);
    expect((await openCall(g)).length).toBe(1);

    // Service off: everything closes as service_off, with no LiveKit call.
    fake.calls.length = 0;
    const off = await mc.reconcileCalls({ serviceOn: false });
    expect(off.closed).toEqual({ reconciled: 0, cap_reached: 0, service_off: 1 });
    expect(fake.calls).toEqual([]);
    expect(await openCall(g)).toEqual([]);
    expect((await lastLine(g))[0]!.body).toBe('Call ended: calls were switched off on this brain.');
    // The throttle: one pass a minute per process.
    const before = fake.calls.length;
    await mc.maybeReconcileCalls(1_000_000);
    await mc.maybeReconcileCalls(1_000_000 + 30_000);
    expect(fake.calls.length).toBe(before);
  });

  // ── Admin acts, leave, the agent stub ──────────────────────────────────

  it('an admin ends the call or removes a person; a non-admin is refused; in a direct chat either ends; leave is a courtesy; the agent stub refuses and records nothing', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, C],
      title: 'Room 7',
    });
    const call = await mc.startOrJoinCall(actor(A), g);
    await mc.startOrJoinCall(actor(B), g);
    await expect(mc.endCall(actor(B), g)).rejects.toThrow(ms.MessengerRefusedError);
    await expect(mc.removeCallParticipant(actor(B), g, A)).rejects.toThrow(
      ms.MessengerRefusedError,
    );
    await expect(mc.addCallAgent(actor(A), g, agent)).rejects.toThrow(mc.MessengerCallsNotYetError);
    await expect(mc.removeCallAgent(actor(A), g)).rejects.toThrow(mc.MessengerCallsNotYetError);
    await expect(mc.addCallAgent(actor(D), g, agent)).rejects.toThrow(ms.MessengerNotFoundError);
    expect((await stays(call.callId!)).every((s) => s.kind === 'login')).toBe(true);
    fake.calls.length = 0;
    await mc.removeCallParticipant(actor(A), g, B);
    expect(fake.calls).toEqual([
      { op: 'removeParticipant', room: `msgr-${g}`, identity: `login:${B}` },
    ]);
    expect((await stays(call.callId!)).map((s) => [s.login_id, s.open])).toEqual([
      [A, true],
      [B, false],
    ]);
    // Leave: a courtesy mark and the room told.
    await mc.startOrJoinCall(actor(C), g);
    fake.calls.length = 0;
    await mc.leaveCall(actor(C), g);
    expect(fake.calls).toEqual([
      { op: 'removeParticipant', room: `msgr-${g}`, identity: `login:${C}` },
    ]);
    expect((await stays(call.callId!)).find((s) => s.login_id === C)!.open).toBe(false);
    fake.calls.length = 0;
    await mc.endCall(actor(A), g);
    expect(fake.calls).toEqual([{ op: 'deleteRoom', room: `msgr-${g}` }]);
    expect(await openCall(g)).toEqual([]);
    const [line] = await lastLine(g);
    expect(line!.body).toBe('Ann ended the call.');
    expect(line!.event).toMatchObject({ type: 'call_ended', callId: call.callId });
    await expect(mc.endCall(actor(A), g)).rejects.toThrow(ms.MessengerNotFoundError);

    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'direct',
      participants: [D],
    });
    await mc.startOrJoinCall(actor(A), c);
    await mc.endCall(actor(D), c);
    expect(await openCall(c)).toEqual([]);
    expect((await lastLine(c))[0]!.body).toBe('Dan ended the call.');
  });

  // ── Row security and history ───────────────────────────────────────────

  it('a call row reads as its "call started" line: participants read, a leaver up to its leave, nobody else', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
      title: 'Room 8',
    });
    const first = await mc.startOrJoinCall(actor(A), g);
    await mc.endCall(actor(A), g);
    await ms.leaveMessengerConversation(actor(B), g);
    const second = await mc.startOrJoinCall(actor(A), g);
    const callsWhere = `conversation_id = '${g}'`;
    expect((await raw(A, 'messenger_calls', callsWhere)).map((r) => r.id).sort()).toEqual(
      [first.callId, second.callId].sort(),
    );
    expect((await raw(B, 'messenger_calls', callsWhere)).map((r) => r.id)).toEqual([first.callId]);
    expect(await raw(C, 'messenger_calls', callsWhere)).toEqual([]);
    expect(await raw(owner, 'messenger_calls', callsWhere)).toEqual([]);
    const staysWhere = `call_id in ('${first.callId}', '${second.callId}')`;
    expect((await raw(A, 'messenger_call_participants', staysWhere)).length).toBe(2);
    expect((await raw(B, 'messenger_call_participants', staysWhere)).length).toBe(1);
    expect(await raw(C, 'messenger_call_participants', staysWhere)).toEqual([]);
    // The replay guard is the system's alone: the workspace role holds no
    // grant on it at all (42501), not even an empty read.
    await mc.applyCallWebhook(webhook('participant_joined', `msgr-${g}`, `login:${A}`, 'EV_rls'));
    await expect(raw(A, 'messenger_call_webhooks', `event_id = 'EV_rls'`)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }),
    });
    // The module's history answers the same window.
    const mine = await as(A, () => mc.listCalls(actor(A), g));
    expect(mine.calls.map((x) => x.id)).toEqual([second.callId, first.callId]);
    expect(mine.calls[1]!.endedReason).toBe('closed_by_admin');
    expect(mine.calls[1]!.participants).toEqual([
      expect.objectContaining({ kind: 'login', id: A, leftAt: expect.any(String) }),
    ]);
    const left = await as(B, () => mc.listCalls(actor(B), g));
    expect(left.calls.map((x) => x.id)).toEqual([first.callId]);
    const page = await as(A, () => mc.listCalls(actor(A), g, { limit: 1 }));
    expect(page.hasMore).toBe(true);
    const older = await as(A, () =>
      mc.listCalls(actor(A), g, { limit: 1, before: page.calls[0]!.startedAt }),
    );
    expect(older.calls.map((x) => x.id)).toEqual([first.callId]);
    expect(older.hasMore).toBe(false);
    // The message read carries the event.
    const msgs = await as(A, () => ms.listMessengerMessages(actor(A), g, { limit: 100 }));
    expect(msgs.messages.filter((x) => x.event?.type === 'call_started').length).toBe(2);
  });

  // ── The chat's gate holds for the room; the audit's fixes ──────────────

  it('two starters at once make one call; a leave or a removal from the chat drops the login from the call; the reconciler drops a stranger and ignores an unknown id; an end with LiveKit down writes nothing', async () => {
    const { conversationId: g } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B, C, D],
      title: 'Room 9',
    });
    // Two taps in parallel: one row, two tokens for the same call.
    const [x, y] = await Promise.all([
      mc.startOrJoinCall(actor(A), g),
      mc.startOrJoinCall(actor(B), g),
    ]);
    expect(x.callId).toBe(y.callId);
    expect((await openCall(g)).length).toBe(1);
    expect(
      (await su(
        sqlTag`select count(*)::int as n from messenger_messages where conversation_id = ${g} and event->>'type' = 'call_started'`,
      )) as {
        n: number;
      }[],
    ).toEqual([{ n: 1 }]);
    await mc.startOrJoinCall(actor(C), g);
    await mc.startOrJoinCall(actor(D), g);
    const room = `msgr-${g}`;
    // B leaves the chat: its stay closes and the room drops it.
    fake.calls.length = 0;
    await ms.leaveMessengerConversation(actor(B), g);
    expect(fake.calls).toContainEqual({ op: 'removeParticipant', room, identity: `login:${B}` });
    expect((await stays(x.callId!)).find((s) => s.login_id === B)!.open).toBe(false);
    // The admin removes C from the chat: the same.
    fake.calls.length = 0;
    await ms.removeMessengerParticipant(actor(A), g, C);
    expect(fake.calls).toContainEqual({ op: 'removeParticipant', room, identity: `login:${C}` });
    expect((await stays(x.callId!)).find((s) => s.login_id === C)!.open).toBe(false);
    // Neither can take a token any more; the webhook re-opens no stay for
    // them and the room drops them.
    await expect(mc.startOrJoinCall(actor(B), g)).rejects.toThrow(ms.MessengerRefusedError);
    await expect(mc.refreshCallToken(actor(C), g)).rejects.toThrow(ms.MessengerRefusedError);
    fake.calls.length = 0;
    expect(await mc.applyCallWebhook(webhook('participant_joined', room, `login:${B}`))).toBe(
      'ignored',
    );
    expect(fake.calls).toEqual([{ op: 'removeParticipant', room, identity: `login:${B}` }]);
    expect((await stays(x.callId!)).find((s) => s.login_id === B)!.open).toBe(false);
    // The reconciler: B back in the room (a token still in hand) is dropped,
    // an id that names nobody is ignored, D is corrected as present.
    fake.join(room, `login:${B}`);
    fake.join(room, `login:${randomUUID()}`);
    fake.join(room, `login:${D}`);
    fake.calls.length = 0;
    const r = await mc.reconcileCalls();
    expect(fake.calls).toContainEqual({ op: 'removeParticipant', room, identity: `login:${B}` });
    expect(
      (await stays(x.callId!))
        .filter((s) => s.open)
        .map((s) => s.login_id)
        .sort(),
    ).toEqual([D].sort());
    expect(r.closed).toEqual({ reconciled: 0, cap_reached: 0, service_off: 0 });
    // A webhook for an id that names nobody is ignored, not an error.
    expect(
      await mc.applyCallWebhook(webhook('participant_joined', room, `login:${randomUUID()}`)),
    ).toBe('ignored');
    // An end while LiveKit is down: 503, the row stays open, no line.
    const before = (await lastLine(g))[0]!.seq;
    fake.setUnreachable(true);
    await expect(mc.endCall(actor(A), g)).rejects.toThrow(lk.LivekitUnavailableError);
    expect((await openCall(g)).length).toBe(1);
    expect((await lastLine(g))[0]!.seq).toBe(before);
    fake.setUnreachable(false);
    await mc.endCall(actor(A), g);
    expect(await openCall(g)).toEqual([]);
  });

  // ── The assistant twin ─────────────────────────────────────────────────

  it('a call with your own assistant: only with the agent flag, for an agent you may chat with, no row', async () => {
    await expect(mc.startAssistantCall(actor(A), agent)).rejects.toThrow(mc.MessengerCallsOffError);
    process.env.MANTLE_CALLS_AGENT = '1';
    await expect(mc.startAssistantCall(actor(A), randomUUID())).rejects.toThrow(
      ms.MessengerNotFoundError,
    );
    fake.calls.length = 0;
    const out = await mc.startAssistantCall(actor(A), agent, { device: 'web' });
    expect(out.callId).toBeNull();
    expect(out.room).toBe(`asst-${agent}-${A}`);
    expect(decode(out.token).sub).toBe(`login:${A}`);
    expect(out.ice?.username).toBe(`asst-${agent}-${A}`);
    expect(fake.calls.map((x) => x.op)).toEqual(['ensureRoom', 'removeParticipant']);
    fake.calls.length = 0;
    await mc.startAssistantCall(actor(A), agent, { refresh: true });
    expect(fake.calls.map((x) => x.op)).toEqual(['ensureRoom']);
    const [n] = (await su(
      sqlTag`select count(*)::int as n from messenger_calls where room_name like 'asst-%'`,
    )) as { n: number }[];
    expect(n!.n).toBe(0);
  });
});

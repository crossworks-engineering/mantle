/**
 * The messenger's live fan-out (Messenger V1, plan page d8954876 section 7)
 * on a migrated scratch brain: the one LISTEN of lib/realtime.ts hands a
 * messenger_changed NOTIFY only to the streams of the conversation's
 * participants (the fan-out map), a left participant hears no message past
 * its left_seq, a typing event skips the typist, and no event carries text.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/realtime-messenger.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the messenger fan-out (lib/realtime.ts)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('@mantle/content/messenger');
  let rt: typeof import('./realtime');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `rm${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const W = randomUUID();
  const heard: Record<string, string[]> = { [A]: [], [B]: [], [C]: [] };
  const offs: (() => void)[] = [];
  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('@mantle/content/messenger');
    rt = await import('./realtime');
    sqlTag = (await import('drizzle-orm')).sql;
    const su = (q: ReturnType<typeof sqlTag>) => ts.superuserExec(scratch!.url, q);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat')`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${C})`);
    for (const l of [A, B, C]) {
      offs.push(await rt.subscribeMessenger(l, (c) => heard[l]!.push(JSON.stringify(c))));
    }
  }, 180_000);

  afterAll(async () => {
    for (const off of offs) off();
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('a NOTIFY reaches only the participants, never with text', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    const secret = `secret-${randomUUID()}`;
    const { message } = await ms.sendMessengerMessage(actor(A), c, { body: secret });
    const isIt = (e: string) =>
      e.includes(c) && e.includes('"new"') && e.includes(`"seq":${message.seq}`);
    await ts.pollUntil(() => heard[A]!.some(isIt) && heard[B]!.some(isIt), {
      what: 'the participants hear the message',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(heard[C]!.filter((e) => e.includes(c))).toEqual([]);
    for (const e of [...heard[A]!, ...heard[B]!]) expect(e).not.toContain(secret);
    expect(JSON.parse(heard[B]!.find(isIt)!)).toEqual({
      c,
      seq: message.seq,
      kind: 'new',
      actor: A,
    });
  });

  it('a left participant hears nothing past its left_seq; typing skips the typist', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    await ms.leaveMessengerConversation(actor(B), c);
    const { message } = await ms.sendMessengerMessage(actor(A), c, { body: 'after' });
    const after = (e: string) => e.includes(c) && e.includes(`"seq":${message.seq}`);
    await ts.pollUntil(() => heard[A]!.some(after), {
      what: 'A hears the message after the leave',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(heard[B]!.filter(after)).toEqual([]);
    const { conversationId: d } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    await m.withViewer({ login: A }, () => ms.messengerTyping(actor(A), d));
    await ts.pollUntil(() => heard[B]!.some((e) => e.includes('typing')), {
      what: 'B hears typing',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(heard[A]!.filter((e) => e.includes('typing'))).toEqual([]);
    expect(heard[C]).toEqual([]);
  });
});

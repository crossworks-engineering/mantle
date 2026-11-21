/**
 * Fleet chat phase 1 on one box (plan page f2f19c7b, sections 2 to 4 and
 * 11), on a migrated scratch brain on workspaces:
 *
 *  - a group's handle and intake form (0394): the format, the reserved
 *    words, an agent's slug, a taken handle (409), admins only, a system
 *    line, the table's checks past the module;
 *  - a handle in a message writes a copy line in the handle's group, for
 *    any login on the box; at most 3 handles; a Reply on the copy line
 *    writes the line back in the first chat; a sender who left: the answer
 *    stays in the group;
 *  - a send to a handle with no open chat: one "To @handle" thread, made
 *    once even for two sends at once; a member posts in the group itself;
 *  - the intake answers, with the box's version;
 *  - the directory lists the handles to every login;
 *  - a copy one way and a line back the other way at once: no deadlock.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/messenger-handles.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('fleet chat: handles on one box (0394)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `mh${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const W = randomUUID();
  const W2 = randomUUID();
  const agentSlug = `${tag}-tess`;

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  const as = <T>(loginId: string, fn: () => Promise<T>) => m.withViewer({ login: loginId }, fn);
  const lines = async (who: string, c: string) =>
    (await as(who, () => ms.listMessengerMessages(actor(who), c, { limit: 100 }))).messages;
  const group = async (who: string, others: string[], extra: Record<string, unknown> = {}) =>
    (
      await ms.createMessengerConversation(actor(who), {
        kind: 'group',
        participants: others,
        ...extra,
      })
    ).conversationId;

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('./messenger');
    sqlTag = (await import('drizzle-orm')).sql;
    await ts.ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    su = (q) => ts.superuserExec(scratch!.url, q);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin', true, 'Olive Owner')`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sqlTag`insert into auth.users (id, email, password_hash, role, display_name) values
      (${A}, ${`${tag}-a@example.invalid`}, 'x', 'member', 'Ann'),
      (${B}, ${`${tag}-b@example.invalid`}, 'x', 'member', 'Ben'),
      (${C}, ${`${tag}-c@example.invalid`}, 'x', 'member', 'Cat')`);
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${W}, ${owner}, ${`${tag} W`}), (${W2}, ${owner}, ${`${tag} W2`})`);
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C})`);
    // Cat shares no workspace with Ann or Ben: a handle is still an inbox.
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W2}, ${C})`);
    await su(sqlTag`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${randomUUID()}, ${owner}, ${agentSlug}, 'Tess', 'test/model', 'x', 'assistant', ${W})`);
  }, 180_000);

  beforeEach(() => ms?.resetMessengerBudgetsForTests());

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('a handle: format, reserved words, agent slugs, taken (409), admins only, a line', async () => {
    const g = await group(A, [B], { title: 'Bugs', handle: '@Defects', intake: 'bug' });
    const read = (who: string) => as(who, () => ms.getMessengerConversation(actor(who), g));
    expect(await read(B)).toMatchObject({ handle: 'defects', intake: 'bug' });
    for (const bad of ['b', '-ab', 'ab-', 'a b', 'x'.repeat(31), 'ab_c']) {
      await expect(group(A, [], { handle: bad })).rejects.toThrow(/2 to 30/);
    }
    for (const word of [
      'all',
      'here',
      'everyone',
      'admin',
      'system',
      'it',
      'bugs',
      'feature',
      'requests',
    ]) {
      await expect(group(A, [], { handle: word })).rejects.toThrow(/reserved/);
    }
    await expect(group(A, [], { handle: agentSlug })).rejects.toThrow(/agent/);
    await expect(group(C, [], { handle: 'defects' })).rejects.toThrow(/taken/);
    await expect(group(A, [], { intake: 'order' })).rejects.toThrow(/bug, feature, request/);
    await expect(
      ms.createMessengerConversation(actor(A), { kind: 'direct', participants: [B], handle: 'dm' }),
    ).rejects.toThrow(/direct chat has no handle/);
    // A member who is no admin is refused; an admin renames it, with a line.
    await expect(ms.patchMessengerConversation(actor(B), g, { handle: 'mine' })).rejects.toThrow(
      ms.MessengerRefusedError,
    );
    const other = await group(C, [], { handle: 'cats' });
    await expect(ms.patchMessengerConversation(actor(A), g, { handle: 'cats' })).rejects.toThrow(
      /taken/,
    );
    await ms.patchMessengerConversation(actor(A), g, { handle: 'defects-2' });
    expect((await lines(B, g)).at(-1)!.body).toBe("Ann set the group's handle to @defects-2.");
    await ms.patchMessengerConversation(actor(A), g, { handle: 'defects', intake: null });
    expect(await read(A)).toMatchObject({ handle: 'defects', intake: null });
    expect((await lines(B, g)).at(-1)!.body).toBe("Ann cleared the group's intake form.");
    await ms.patchMessengerConversation(actor(A), g, { intake: 'bug' });
    // The checks hold past the module.
    await expect(
      su(sqlTag`update messenger_conversations set handle = 'Bad Handle' where id = ${other}`),
    ).rejects.toThrow(/messenger_conversations_handle_ck/);
    await expect(
      su(sqlTag`update messenger_conversations set handle = 'defects' where id = ${other}`),
    ).rejects.toThrow(/messenger_conversations_handle_uq/);
  });

  it('a handle in a message writes a copy in the group; a Reply on it goes back', async () => {
    const bugs = await ms.findHandleGroup(actor(A), 'defects');
    const mine = await group(C, []);
    const sent = await ms.sendMessengerMessage(actor(C), mine, {
      body: '@defects the export is blank',
      mentions: [{ kind: 'handle', id: bugs.id }],
    });
    const copy = (await lines(A, bugs.id)).at(-1)!;
    expect(copy).toMatchObject({
      authorKind: 'system',
      authorName: 'Cat',
      body: '@defects the export is blank',
      event: { type: 'intake', from: { conversationId: mine, seq: sent.message.seq }, by: C },
    });
    expect(sent.message.mentions).toEqual([
      { kind: 'handle', id: bugs.id, handle: 'defects', seq: copy.seq },
    ]);
    // Cat reads nothing of the group: she is no member.
    await expect(as(C, () => ms.getMessengerConversation(actor(C), bugs.id))).rejects.toThrow(
      ms.MessengerNotFoundError,
    );
    // A normal line in the group stays there.
    const before = (await lines(C, mine)).length;
    await ms.sendMessengerMessage(actor(B), bugs.id, { body: 'Looking.' });
    expect((await lines(C, mine)).length).toBe(before);
    // A Reply on the copy line goes back.
    await ms.sendMessengerMessage(actor(A), bugs.id, {
      body: 'Fixed in the next release.',
      replyToSeq: copy.seq,
    });
    const back = (await lines(C, mine)).at(-1)!;
    expect(back).toMatchObject({
      authorKind: 'system',
      body: '@defects, Ann: Fixed in the next release.',
      replyToSeq: sent.message.seq,
      event: {
        type: 'intake_answer',
        group: { conversationId: bugs.id, handle: 'defects' },
        by: A,
      },
    });
    // At most 3 handles; an unknown or archived group is refused.
    const extra = await Promise.all(
      ['h-one', 'h-two', 'h-three'].map((h) => group(A, [], { handle: h })),
    );
    await expect(
      ms.sendMessengerMessage(actor(C), mine, {
        body: 'too many',
        mentions: [bugs.id, ...extra].map((id) => ({ kind: 'handle' as const, id })),
      }),
    ).rejects.toThrow(/at most 3 handles/);
    await expect(
      ms.sendMessengerMessage(actor(C), mine, {
        body: 'nobody',
        mentions: [{ kind: 'handle', id: mine }],
      }),
    ).rejects.toThrow(/group with a handle/);
  });

  it('the sender left the first chat: the answer stays in the group', async () => {
    const bugs = await ms.findHandleGroup(actor(A), 'defects');
    const shared = await group(B, [A]);
    const sent = await ms.sendMessengerMessage(actor(B), shared, {
      body: 'crash on save',
      mentions: [{ kind: 'handle', id: bugs.id }],
    });
    const copySeq = sent.message.mentions.find((x) => x.kind === 'handle')!;
    await ms.leaveMessengerConversation(actor(B), shared);
    const before = (await lines(A, shared)).length;
    const answer = await ms.sendMessengerMessage(actor(A), bugs.id, {
      body: 'Which file?',
      replyToSeq: (copySeq as { seq: number }).seq,
    });
    expect((await lines(A, shared)).length).toBe(before);
    expect((await lines(A, bugs.id)).at(-1)).toMatchObject({
      authorKind: 'system',
      event: { type: 'intake_sender_left', seq: answer.message.seq },
    });
    // The replier read the line the send wrote after the reply too.
    const row = (await as(A, () => ms.listMessengerConversations(actor(A)))).find(
      (r) => r.id === bugs.id,
    )!;
    expect(row.unread).toBe(0);
  });

  it('a retry of a stored line answers it, though the handle is gone since', async () => {
    const desk = await group(A, [], { handle: 'retry-desk' });
    const mine = await group(C, []);
    const first = await ms.sendMessengerMessage(actor(C), mine, {
      body: 'once',
      clientMsgId: 'retry-1',
      mentions: [{ kind: 'handle', id: desk }],
    });
    await su(sqlTag`update messenger_conversations set archived_at = now() where id = ${desk}`);
    const again = await ms.sendMessengerMessage(actor(C), mine, {
      body: 'once',
      clientMsgId: 'retry-1',
      mentions: [{ kind: 'handle', id: desk }],
    });
    expect(again.created).toBe(false);
    expect(again.message.seq).toBe(first.message.seq);
  });

  it('to a handle with no open chat: one "To @defects" thread; a member posts in the group', async () => {
    const bugs = await ms.findHandleGroup(actor(A), 'defects');
    const [x, y] = await Promise.all([
      ms.sendMessengerTo(actor(C), { handle: '@defects' }, { body: 'first' }),
      ms.sendMessengerTo(actor(C), { handle: 'defects' }, { body: 'second' }),
    ]);
    expect(x.conversationId).toBe(y.conversationId);
    const thread = await as(C, () => ms.getMessengerConversation(actor(C), x.conversationId));
    expect(thread).toMatchObject({ kind: 'group', title: 'To @defects' });
    expect(thread.participants.map((p) => p.id)).toEqual([C]);
    const tl = await lines(C, x.conversationId);
    expect(tl[0]).toMatchObject({
      authorKind: 'system',
      event: { type: 'to_thread', to: { conversationId: bugs.id } },
    });
    expect(
      tl
        .filter((l) => l.authorKind === 'login')
        .map((l) => l.body)
        .sort(),
    ).toEqual(['first', 'second']);
    const z = await ms.sendMessengerTo(actor(C), { handle: 'defects' }, { body: 'third' });
    expect(z.conversationId).toBe(x.conversationId);
    // A member of the group posts in it, with no copy.
    const before = (await lines(A, bugs.id)).length;
    const own = await ms.sendMessengerTo(actor(A), { handle: 'defects' }, { body: 'note' });
    expect(own.conversationId).toBe(bugs.id);
    expect((await lines(A, bugs.id)).length).toBe(before + 1);
    await expect(ms.sendMessengerTo(actor(C), { handle: 'nobody' }, { body: 'x' })).rejects.toThrow(
      /No group/,
    );
  });

  it('the intake answers: the filled form, the box version; unknown keys refused', async () => {
    const out = await ms.sendMessengerTo(
      actor(C),
      { handle: 'defects' },
      { body: '', answers: { did: 'Opened the report', happened: 'A blank page' } },
    );
    expect(out.message.body).toMatch(
      /^\*\*What did you do\?\*\*\nOpened the report\n\n\*\*What happened\?\*\*\nA blank page\n\nBox version: /,
    );
    await expect(
      ms.sendMessengerTo(actor(C), { handle: 'defects' }, { body: '', answers: { why: 'x' } }),
    ).rejects.toThrow(/no question "why"/);
    await expect(
      ms.sendMessengerTo(actor(C), { handle: 'defects' }, { body: '', answers: { did: '  ' } }),
    ).rejects.toThrow(/at least one/);
    await expect(
      ms.sendMessengerTo(actor(C), { handle: 'cats' }, { body: '', answers: { did: 'x' } }),
    ).rejects.toThrow(/intake form/);
  });

  it('the directory lists the handles to every login, with whether I am in it', async () => {
    const rows = (await ms.messengerDirectory(actor(C), '@bu')).filter((e) => e.kind === 'handle');
    expect(rows).toEqual([
      expect.objectContaining({ handle: 'defects', name: 'Bugs', intake: 'bug', member: false }),
    ]);
    const forA = (await ms.messengerDirectory(actor(A), 'defects')).find(
      (e) => e.handle === 'defects',
    );
    expect(forA?.member).toBe(true);
  });

  it('a copy one way and a line back the other way at once: both land', async () => {
    const bugs = await ms.findHandleGroup(actor(A), 'defects');
    const mine = await group(C, []);
    const first = await ms.sendMessengerMessage(actor(C), mine, {
      body: 'one',
      mentions: [{ kind: 'handle', id: bugs.id }],
    });
    const copy = first.message.mentions.find((x) => x.kind === 'handle') as { seq: number };
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        ms.sendMessengerMessage(actor(C), mine, {
          body: `more ${i}`,
          mentions: [{ kind: 'handle', id: bugs.id }],
        }),
        ms.sendMessengerMessage(actor(A), bugs.id, { body: `answer ${i}`, replyToSeq: copy.seq }),
      );
    }
    await Promise.all(runs);
    const back = (await lines(C, mine)).filter((l) => l.event?.type === 'intake_answer');
    expect(back).toHaveLength(5);
  });
});

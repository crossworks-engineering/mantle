/**
 * The IT desks (fleet chat phase 1, milestone 3; plan page f2f19c7b,
 * section 7, D3 A), on a migrated scratch brain on workspaces, with the
 * object store in memory and a temporary files root:
 *
 *  Box side (a box linked to a Control Center):
 *  - the directory lists the three desks with their site; none when the
 *    box is not linked, and a desk mention is refused there;
 *  - a line to @bugs (IT) makes my own task with the line's text and
 *    files, sent to IT with the chat in its block; the line names the task;
 *  - every reader of the line sees its status: sent, received, answered;
 *  - the Control Center's reply comes back as a line in that chat, a reply
 *    to the first line;
 *  - a line that fails takes its task off again;
 *  - `to` a desk with no open chat: one "To @bugs (IT)" thread; a site
 *    the box does not know is refused.
 *
 *  Control Center side:
 *  - a report from a box is a copy line in the group whose intake form is
 *    its kind, with its files; no such group: no line;
 *  - a Reply on it by who may edit the copy answers the copy once; one by
 *    who may not, or a second one, stays in the group with a line saying so.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/messenger-desks.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@mantle/files/broker', () => ({
  stageFileObject: vi.fn(async (bytes: Buffer) => {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = `attachments/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
    store.set(key, bytes);
    return { key };
  }),
  stageSpooledObject: vi.fn(),
}));
vi.mock('@mantle/storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getContent: vi.fn(async (key: string) => {
    const b = store.get(key);
    if (!b) throw new Error('NoSuchKey');
    return { body: Readable.from([b]), contentLength: b.length };
  }),
}));

/** The two Control Center lines of a linked box (their form only). */
const LINKED = {
  MANTLE_CONTROL_CENTER: 'https://cc.example.invalid',
  MANTLE_CONTROL_CENTER_KEY: `ed25519:${'A'.repeat(43)}=`,
  MANTLE_PUBLIC_URL: 'https://box.example.invalid',
} as const;

describe.skipIf(!URL)('fleet chat: the IT desks', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
  let ma: typeof import('./messenger-attachments');
  let sub: typeof import('./submissions');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;
  const prevEnv: Record<string, string | undefined> = {};
  let root = '';

  const tag = `dk${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const W = randomUUID();
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  /** Run `fn` as `who`, in a write request's scope (as its routes do). */
  const asWriter = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.loginScopeFor(who);
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: true, drafts: false });
      return fn();
    });
  };
  const lines = async (who: string, c: string) =>
    (await asWriter(who, () => ms.listMessengerMessages(actor(who), c, { limit: 100 }))).messages;
  const send = (who: string, c: string, input: Parameters<typeof ms.sendMessengerMessage>[2]) =>
    asWriter(who, () => ms.sendMessengerMessage(actor(who), c, input));
  const group = async (who: string, others: string[], extra: Record<string, unknown> = {}) =>
    (
      await ms.createMessengerConversation(actor(who), {
        kind: 'group',
        participants: others,
        ...extra,
      })
    ).conversationId;
  const block = async (taskId: string) =>
    (
      (await m.systemDb.execute(sqlTag`select title, tags, data -> 'submission' as s
        from nodes where id = ${taskId}`)) as unknown as {
        title: string;
        tags: string[];
        s: Record<string, unknown> | null;
      }[]
    )[0];
  const deskOf = (line: { mentions: readonly { kind: string }[] }) =>
    line.mentions.find((x) => x.kind === 'desk') as
      { kind: 'desk'; id: string; taskId?: string; status?: string } | undefined;
  const link = (on: boolean) => {
    for (const [k, v] of Object.entries(LINKED)) {
      if (on) process.env[k] = v;
      else delete process.env[k];
    }
  };

  beforeAll(async () => {
    for (const k of [...Object.keys(LINKED), 'MANTLE_FILES_ROOT', 'MANTLE_CONTROL_CENTER_LABEL'])
      prevEnv[k] = process.env[k];
    delete process.env.MANTLE_CONTROL_CENTER_LABEL;
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    root = await mkdtemp(path.join(tmpdir(), 'mantle-desks-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ms = await import('./messenger');
    ma = await import('./messenger-attachments');
    sub = await import('./submissions');
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
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id in (${A}, ${B}, ${C})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id) values
      (${W}, ${A}), (${W}, ${B}), (${W}, ${C})`);
    await (await import('@mantle/files')).ensureFilesRootBranch(owner);
    await mkdir(path.join(root, 'files'), { recursive: true });
  }, 180_000);

  beforeEach(() => {
    ms?.resetMessengerBudgetsForTests();
    link(true);
  });

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (root) await rm(root, { recursive: true, force: true });
  }, 120_000);

  it('the directory lists the desks on a linked box only', async () => {
    const dir = await ms.messengerDirectory(actor(A), 'bugs');
    expect(dir.filter((e) => e.kind === 'desk')).toEqual([
      expect.objectContaining({
        kind: 'desk',
        id: 'bug',
        name: '@bugs (IT)',
        handle: 'bugs',
        intake: 'bug',
        site: 'IT',
      }),
    ]);
    expect(
      (await ms.messengerDirectory(actor(A), '')).filter((e) => e.kind === 'desk'),
    ).toHaveLength(3);
    link(false);
    expect((await ms.messengerDirectory(actor(A), '')).filter((e) => e.kind === 'desk')).toEqual(
      [],
    );
    const c = await group(A, [B]);
    await expect(
      send(A, c, { body: 'x', mentions: [{ kind: 'desk', id: 'bug' }] }),
    ).rejects.toThrow(/no IT desks/);
  });

  it('a line to @bugs (IT): my own task, sent to IT; the status; the answer comes back', async () => {
    const c = await group(A, [B]);
    const f = await asWriter(A, () =>
      ma.uploadMessengerAttachment(actor(A), c, { filename: 'shot.png', bytes: PNG }),
    );
    const sent = await send(A, c, {
      body: 'The export is blank\nOn the cost report.',
      mentions: [{ kind: 'desk', id: 'bug' }],
      attachments: [f.id],
    });
    const mention = deskOf(sent.message)!;
    expect(mention).toMatchObject({ kind: 'desk', id: 'bug', status: 'sent' });
    const taskId = mention.taskId!;
    const t = await block(taskId);
    expect(t!.title).toBe('The export is blank');
    expect(t!.tags).toContain('bug');
    expect(t!.s).toMatchObject({
      side: 'sent',
      kind: 'bug',
      to: 'it',
      chat: { conversationId: c },
    });
    const tf = await import('./task-files');
    const onTask = await asWriter(A, () => tf.listTaskFiles(owner, taskId));
    expect(onTask.map((x) => x.filename)).toEqual(['shot.png']);
    // Ben reads the line and its status too.
    const line = async () => (await lines(B, c)).find((l) => l.seq === sent.message.seq)!;
    expect(deskOf(await line())!.status).toBe('sent');
    // The Control Center took it.
    await m.systemDb.execute(sqlTag`update nodes set data = jsonb_set(data,
      '{submission,collectedAt}', to_jsonb(now()::text)) where id = ${taskId}`);
    expect(deskOf(await line())!.status).toBe('received');
    // Its reply (the box's `reply` case): the task is done, and a line.
    const reply = sub.replyOf('Fixed in the next release.', '0.710.0', 'Dana');
    expect(await sub.deliverReply(owner, taskId, reply, 'it')).toBe(true);
    expect(await ms.deskAnswerLine(owner, taskId, { note: reply.note, by: reply.by })).toBe(true);
    expect(deskOf(await line())!.status).toBe('answered');
    const back = (await lines(A, c)).at(-1)!;
    expect(back).toMatchObject({
      authorKind: 'system',
      body: '@bugs (IT), Dana: Fixed in the next release.',
      replyToSeq: sent.message.seq,
      event: { type: 'desk_answer', desk: 'bug', taskId },
    });
  });

  it('a line that fails takes its task off; a retry makes no second task', async () => {
    const theirs = await group(C, []);
    const count = async (body: string) =>
      (
        (await m.systemDb.execute(sqlTag`select count(*)::int as n from nodes
          where owner_id = ${owner} and type = 'task' and data ->> 'body' = ${body}`)) as unknown as {
          n: number;
        }[]
      )[0]!.n;
    await expect(
      send(A, theirs, { body: 'not my chat', mentions: [{ kind: 'desk', id: 'request' }] }),
    ).rejects.toThrow();
    expect(await count('not my chat')).toBe(0);
    const mine = await group(A, []);
    const one = {
      body: 'once only',
      clientMsgId: 'desk-1',
      mentions: [{ kind: 'desk' as const, id: 'feature' as const }],
    };
    const first = await send(A, mine, one);
    const again = await send(A, mine, one);
    expect(again.created).toBe(false);
    expect(again.message.seq).toBe(first.message.seq);
    expect(await count('once only')).toBe(1);
    await expect(
      send(A, mine, {
        body: 'two',
        mentions: [
          { kind: 'desk', id: 'bug' },
          { kind: 'desk', id: 'feature' },
        ],
      }),
    ).rejects.toThrow(/at most one IT desk/);
  });

  it('to a desk with no open chat: one "To @bugs (IT)" thread; an unknown site is refused', async () => {
    const x = await asWriter(A, () =>
      ms.sendMessengerTo(actor(A), { handle: '@bugs', site: 'IT' }, { body: 'first' }),
    );
    const y = await asWriter(A, () =>
      ms.sendMessengerTo(actor(A), { handle: 'bugs' }, { body: 'second' }),
    );
    expect(y.conversationId).toBe(x.conversationId);
    const thread = await ms.getMessengerConversation(actor(A), x.conversationId);
    expect(thread).toMatchObject({ kind: 'group', title: 'To @bugs (IT)' });
    expect((await lines(A, x.conversationId))[0]).toMatchObject({
      authorKind: 'system',
      event: { type: 'to_thread', to: { desk: 'bug' } },
    });
    expect(deskOf(x.message)).toMatchObject({ id: 'bug', status: 'sent' });
    await expect(
      asWriter(A, () =>
        ms.sendMessengerTo(actor(A), { handle: 'bugs', site: 'Mars' }, { body: 'x' }),
      ),
    ).rejects.toThrow(/no site named/);
    // A local handle never takes a site.
    await expect(ms.openHandleChat(actor(A), 'qa', 'IT')).rejects.toThrow(/IT desk only/);
  });

  it('on the Control Center: the copy line in the intake group; a Reply answers the copy once', async () => {
    link(false); // a Control Center is no subject box
    const g = await group(owner, [B], { title: 'Bugs', intake: 'bug' });
    const copyId = await sub.makeReceivedCopy(owner, {
      kind: 'bug',
      title: 'Site A: The export is blank',
      body: 'The export is blank',
      from: {
        box: { id: randomUUID(), name: 'Site A' },
        taskId: randomUUID(),
        by: { name: 'Ann', email: 'a@x' },
      },
      files: [],
    });
    const box = { id: randomUUID(), name: 'Site A' };
    expect(
      await ma.deskCopyLine(owner, {
        kind: 'bug',
        authorName: 'Ann (Site A)',
        body: 'The export is blank',
        copyTaskId: copyId,
        box,
        files: [
          { filename: 'shot.png', bytes: PNG },
          { filename: 'page.html', bytes: Buffer.from('<p>') },
        ],
      }),
    ).toBe(true);
    const copy = (await lines(B, g)).at(-1)!;
    expect(copy).toMatchObject({
      authorKind: 'system',
      authorName: 'Ann (Site A)',
      body: 'The export is blank',
      event: { type: 'desk_copy', taskId: copyId, box },
    });
    // The type list holds on the line: the html stays on the task only.
    expect(copy.files.map((x) => x.name)).toEqual(['shot.png']);
    // No group asks for requests: no line.
    expect(
      await ma.deskCopyLine(owner, {
        kind: 'request',
        authorName: 'Ann (Site A)',
        body: 'x',
        copyTaskId: copyId,
        box,
        files: [],
      }),
    ).toBe(false);
    // Ben may not edit the copy (it lives in Admin): his Reply stays here.
    await send(B, g, { body: 'Looking.', replyToSeq: copy.seq });
    expect((await lines(B, g)).at(-1)!.body).toMatch(/Only who may edit the report/);
    expect((await block(copyId))!.s).not.toHaveProperty('reply');
    // The owner answers it: the copy takes the reply, once.
    await send(owner, g, { body: 'Fixed in 0.710.', replyToSeq: copy.seq });
    expect((await block(copyId))!.s).toMatchObject({ reply: { note: 'Fixed in 0.710.' } });
    await send(owner, g, { body: 'Also this.', replyToSeq: copy.seq });
    expect((await lines(owner, g)).at(-1)!.body).toMatch(/one answer already/);
  });
});

/**
 * Files on messenger lines (fleet chat phase 1, plan page f2f19c7b section
 * 8), on a migrated scratch brain on workspaces, with the object store in
 * memory (the files broker and the read API mocked):
 *
 *  - an upload: a live participant only; the types and the 10 MB cap;
 *  - a send claims my own unsent uploads of the chat (at most 5); a file
 *    or nothing; the line lists its files;
 *  - who reads the line reads the file; an unsent one, its uploader only;
 *    an outsider nothing;
 *  - a handle's copy line and the line back carry the files, as new rows
 *    on the same bytes;
 *  - files left out are named on the line;
 *  - Save to Files: a copy into a folder the login may create in, its bytes
 *    read back; refused for a folder the login reads but may not create in,
 *    and for a file the login does not read;
 *  - a deleted line's file is not served.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/messenger-attachments.db.test.ts
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

describe.skipIf(!URL)('fleet chat: files on messenger lines', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ms: typeof import('./messenger');
  let ma: typeof import('./messenger-attachments');
  let sqlTag: typeof import('drizzle-orm').sql;
  let su: (q: ReturnType<typeof import('drizzle-orm').sql>) => Promise<unknown[]>;

  const tag = `ma${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const owner = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const W = randomUUID();
  const EDIT = randomUUID(); // Ben moderates it: he creates in its folders
  const READ = randomUUID(); // Ben only reads its folders
  const editDir = `files.${tag}_edit`;
  const readDir = `files.${tag}_read`;
  let root = '';
  let prevRoot: string | undefined;
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

  const actor = (loginId: string) => ({ ownerId: owner, loginId, via: null });
  const as = <T>(loginId: string, fn: () => Promise<T>) => m.withViewer({ login: loginId }, fn);
  const last = async (who: string, c: string) =>
    (await as(who, () => ms.listMessengerMessages(actor(who), c, { limit: 100 }))).messages.at(-1)!;
  const up = (who: string, c: string, name = 'shot.png', bytes = PNG) =>
    ma.uploadMessengerAttachment(actor(who), c, { filename: name, bytes });
  const open = async (who: string, id: string) => {
    const f = await as(who, () => ma.openMessengerAttachment(actor(who), id));
    if (!f) return null;
    const chunks: Buffer[] = [];
    for await (const c of f.body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };

  /** Run `fn` as `who`, in a write request's scope (as its routes do). */
  const asWriter = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.loginScopeFor(who);
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: true, drafts: false });
      return fn();
    });
  };

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-msgatt-'));
    process.env.MANTLE_FILES_ROOT = root;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ms = await import('./messenger');
    ma = await import('./messenger-attachments');
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
    // Two folders of Files: one homed in a workspace Ben moderates, one in
    // a workspace he only reads.
    await su(sqlTag`insert into workspaces (id, owner_id, name) values
      (${EDIT}, ${owner}, ${`${tag} Edit`}), (${READ}, ${owner}, ${`${tag} Read`})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator) values
      (${EDIT}, ${B}, true), (${READ}, ${B}, false)`);
    const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    for (const [dir, ws] of [
      [editDir, EDIT],
      [readDir, READ],
    ] as const) {
      const slug = dir.slice('files.'.length);
      const [row] = (await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'branch', ${slug}, ${slug}, ${dir}::ltree)
        returning id::text as id`)) as unknown as { id: string }[];
      await m.withSubtreeHeads(row!.id, [], async (tx) => {
        await tx.execute(sqlTag`delete from item_grants where node_id = ${row!.id}`);
        await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, is_home)
                                values (${row!.id}, ${ws}, true)`);
      });
    }
    await mkdir(path.join(root, 'files'), { recursive: true });
  }, 180_000);

  beforeEach(() => ms?.resetMessengerBudgetsForTests());

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    if (root) await rm(root, { recursive: true, force: true });
  }, 120_000);

  it('an upload: a participant only, the types and the cap; a send claims it', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    await expect(up(C, c)).rejects.toThrow(ms.MessengerNotFoundError);
    await expect(up(A, c, 'page.html')).rejects.toThrow(/types/);
    await expect(up(A, c, 'big.png', Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow(
      /Too big/,
    );
    await expect(up(A, c, 'empty.png', Buffer.alloc(0))).rejects.toThrow(/empty/);
    const f = await up(A, c);
    expect(f).toMatchObject({ name: 'shot.png', kind: 'image', bytes: PNG.length });
    // Unsent: the uploader reads it, the other member does not.
    expect(await open(A, f.id)).toEqual(PNG);
    expect(await open(B, f.id)).toBeNull();
    // Ben cannot send Ann's upload.
    await expect(
      ms.sendMessengerMessage(actor(B), c, { body: 'x', attachments: [f.id] }),
    ).rejects.toThrow(/uploaded to this chat/);
    // A line with a file and no text.
    const sent = await ms.sendMessengerMessage(actor(A), c, { body: '', attachments: [f.id] });
    expect(sent.message.files).toEqual([
      { id: f.id, name: 'shot.png', mime: 'image/png', bytes: PNG.length, kind: 'image' },
    ]);
    expect((await last(B, c)).files.map((x) => x.id)).toEqual([f.id]);
    expect(await open(B, f.id)).toEqual(PNG);
    expect(await open(C, f.id)).toBeNull();
    // A file goes on one line only.
    await expect(
      ms.sendMessengerMessage(actor(A), c, { body: 'again', attachments: [f.id] }),
    ).rejects.toThrow(/did not send yet/);
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => up(A, c, `s${i}.png`)));
    await expect(
      ms.sendMessengerMessage(actor(A), c, { body: 'many', attachments: six.map((x) => x.id) }),
    ).rejects.toThrow(/at most 5/);
    await expect(ms.sendMessengerMessage(actor(A), c, { body: '  ' })).rejects.toThrow(
      /some text or a file/,
    );
  });

  it('files left out are named on the line', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [],
    });
    const out = await ms.sendMessengerMessage(actor(A), c, {
      body: 'The logs',
      leftOut: [{ name: 'dump.log', bytes: 12 * 1024 * 1024 }],
    });
    expect(out.message.body).toBe('The logs\n\nNot sent (over 10 MB): dump.log (12.0 MB).');
  });

  it('a copy line and the line back carry the files', async () => {
    const g = (
      await ms.createMessengerConversation(actor(A), {
        kind: 'group',
        participants: [B],
        handle: 'files-desk',
      })
    ).conversationId;
    const mine = (
      await ms.createMessengerConversation(actor(C), { kind: 'group', participants: [] })
    ).conversationId;
    const f = await up(C, mine);
    const sent = await ms.sendMessengerMessage(actor(C), mine, {
      body: 'see the picture',
      attachments: [f.id],
      mentions: [{ kind: 'handle', id: g }],
    });
    const copy = await last(B, g);
    expect(copy.event?.type).toBe('intake');
    expect(copy.files).toHaveLength(1);
    expect(copy.files[0]!.id).not.toBe(f.id);
    expect(await open(B, copy.files[0]!.id)).toEqual(PNG);
    // Cat is no member of the group: she reads her own row, not the copy.
    expect(await open(C, copy.files[0]!.id)).toBeNull();
    expect(sent.message.files[0]!.id).toBe(f.id);
    // The answer with a file goes back with it.
    const fix = await up(A, g, 'fix.txt', Buffer.from('done'));
    await ms.sendMessengerMessage(actor(A), g, {
      body: 'Fixed, see the note.',
      attachments: [fix.id],
      replyToSeq: copy.seq,
    });
    const back = await last(C, mine);
    expect(back.event?.type).toBe('intake_answer');
    expect(back.files.map((x) => x.name)).toEqual(['fix.txt']);
    expect(await open(C, back.files[0]!.id)).toEqual(Buffer.from('done'));
    // Save to Files: an outsider of the chat reads no file to save.
    await expect(
      asWriter(B, () => ma.saveMessengerAttachment(actor(B), back.files[0]!.id, editDir)),
    ).rejects.toThrow(ms.MessengerNotFoundError);
  });

  it('Save to Files copies a chat file into a folder I may create in, nowhere else', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    const bytes = Buffer.from('the site report, page 1');
    const f = await up(A, c, 'report.txt', bytes);
    await ms.sendMessengerMessage(actor(A), c, { body: 'the report', attachments: [f.id] });
    const saved = await asWriter(B, () => ma.saveMessengerAttachment(actor(B), f.id, editDir));
    expect(saved).toMatchObject({ filename: 'report.txt', parentPath: editDir });
    const files = await import('@mantle/files');
    const back = await files.readFileById({ ownerId: owner, fileId: saved.id });
    expect(back?.bytes).toEqual(bytes);
    // A taken name is refused, not overwritten.
    await expect(
      asWriter(B, () => ma.saveMessengerAttachment(actor(B), f.id, editDir)),
    ).rejects.toThrow(/already exists/);
    // A folder Ben reads but may not create in: the database refuses it.
    // The row security refuses it (42501), not any other error.
    const err = (await asWriter(B, () => ma.saveMessengerAttachment(actor(B), f.id, readDir)).catch(
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | undefined;
    expect(err?.code ?? err?.cause?.code).toBe('42501');
    const inRead = (await m.systemDb.execute(sqlTag`select count(*)::int as n from nodes
      where owner_id = ${owner} and type = 'file' and path = ${readDir}::ltree`)) as unknown as {
      n: number;
    }[];
    expect(inRead[0]!.n).toBe(0);
  });

  it('a deleted line serves no file', async () => {
    const { conversationId: c } = await ms.createMessengerConversation(actor(A), {
      kind: 'group',
      participants: [B],
    });
    const f = await up(A, c);
    const sent = await ms.sendMessengerMessage(actor(A), c, { body: 'oops', attachments: [f.id] });
    expect(await open(B, f.id)).toEqual(PNG);
    await ms.deleteMessengerMessage(actor(A), c, sent.message.seq);
    expect(await open(B, f.id)).toBeNull();
    expect(await open(A, f.id)).toBeNull();
  });
});

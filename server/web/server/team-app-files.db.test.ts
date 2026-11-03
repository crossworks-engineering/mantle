/**
 * A team app writes files wherever the user running it may write by hand
 * (owner decision 2026-11-03): the member-app rule (packages/tools
 * member-app-tools.ts rule 7) lets a team app call file_upload, file_move
 * and file_rename (policy memberApp 'files') as the user running it, in
 * that user's own scope, with that user's own rights (a Moderator of the
 * home, or the folder's Write switch), never with confirm: true, and at most
 * 16 MB a call. Another workspace reading the folder refuses nothing for a
 * new file; a move of an existing file that would start or stop a
 * workspace the runner sees reading it is refused (the app cannot confirm
 * it).
 *
 * On a migrated scratch database, through the one app tool broker
 * (lib/app-tool-broker.ts runAppToolBroker) as its routes configure it,
 * with the real verdict, gate, scope and Files operations, the actor check
 * and the edit check on. The Activity and error log rows are stood in.
 *
 *  1. a user with the folder's Write switch uploads a file: it lands in the
 *     folder, homed in the folder's home, indexed as a Files upload is; the
 *     Activity row names the folder and the file, never the bytes;
 *  2. a Moderator replaces it (overwrite): the same file, the new bytes;
 *  3. a user without Write on the folder: refused, nothing lands;
 *  4. a folder homed in Admin, or the files root: refused where it runs;
 *  5. a folder another workspace also reads: it lands, read there too;
 *     confirm: true is refused outright;
 *  6. past 16 MB, content that is not a string, or an indexing of the
 *     app's own: refused before the write;
 *  7. a move by a Moderator lands; by a user who is not one, into a folder
 *     another workspace would start reading it through, or into Admin,
 *     refused;
 *  7b. a move that would stop a workspace the runner is in reading the
 *     file: refused, it stays read there; between folders the same
 *     workspaces read: it lands;
 *  8. a rename of the runner's file lands; of an Admin file, refused;
 *  9. a read-only login and a shared link write nothing; an app two
 *     workspaces hold writes as its runner;
 *  10. a folder of a workspace the runner is in but the app's holder is
 *     not: it lands there, homed there;
 *  11. by hand (no app), the same new file asks for a confirm first: only
 *     a team app's own write treats its folder's readers as no change.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/team-app-files.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const access = vi.hoisted(() => vi.fn());
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAppAccess: access,
  recordAppError: vi.fn(),
  recordShareAccess: vi.fn(),
}));

type Answer = { status: number; body: { ok: boolean; error?: string; output?: unknown } };

describe.skipIf(!URL)('a team app writes files where its runner may', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let files: typeof import('@mantle/files');
  let broker: typeof import('@/lib/app-tool-broker');
  let dir = '';
  const tag = `taf${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A user of the holder workspace, not a Moderator. */
  const member = randomUUID();
  /** A Moderator of the holder workspace. */
  const moderator = randomUUID();
  let adminWs = '';
  let holderWs = '';
  let otherWs = '';
  /** A workspace both runners are plain users of; the app's holder is not
   *  it. */
  let elseWs = '';
  let teamApp = '';
  let twoHolderApp = '';
  /** Holder folders: Write on for the holder's users, Write off, another
   *  workspace reads it too. */
  let open = '';
  let closed = '';
  let shared = '';
  /** Holder folders elseWs reads too (Write on for the holder). */
  let both = '';
  let both2 = '';
  /** A folder homed in elseWs, Write on there. */
  let elsewhere = '';
  let adminFolder = '';
  let adminFile = '';
  /** A file homed in the holder, in the `both` folder: elseWs reads it
   *  through that folder. */
  let bothFile = '';
  const savedEnv: Record<string, string | undefined> = {};

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const SLUGS = ['file_upload', 'file_move', 'file_rename', 'file_list'];

  type Req = { mode?: 'rw' | 'ro'; writes?: boolean };

  /** `fn` in `login`'s request scope, as the session guard enters it for a
   *  POST. */
  const inRequest = async <T>(login: string, fn: () => Promise<T>, req: Req = {}): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runInRequestSlot(
      async () => {
        if (!m.enterRequestScope(scope, { writes: req.writes ?? true, drafts: true })) {
          throw new Error('the request scope was not entered');
        }
        return fn();
      },
      { startsAs: m.loginActor(login, req.mode ?? 'rw') },
    ) as Promise<T>;
  };

  const request = (slug: string, input: Record<string, unknown>) =>
    new Request('http://brain.invalid/api/apps/x/tool-broker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, input }),
    });

  const answer = async (res: Response): Promise<Answer> => ({
    status: res.status,
    body: (await res.json()) as Answer['body'],
  });

  /** A member's run of an app (lib/app-runner.ts memberToolBroker). */
  const memberCall = (
    login: string,
    slug: string,
    input: Record<string, unknown>,
    req: Req = {},
    appId = teamApp,
  ) =>
    inRequest(
      login,
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'member',
            ownerId: owner,
            runner: { loginId: login, name: 'Runner' },
            maxBytes: 8 * 1024 * 1024,
            fileMaxBytes: 24 * 1024 * 1024,
            app: async () => ({ id: appId, manifest: { toolSlugs: SLUGS } }),
            system: (fn) => m.asSystem(fn, 'app-data'),
          }),
        ),
      req,
    );

  /** A shared link's run (POST /s/:token/tool-broker, past its code gate). */
  const linkCall = (slug: string, input: Record<string, unknown>) =>
    m.asSystem(
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'contact',
            ownerId: owner,
            share: { id: randomUUID(), contactId: randomUUID() },
            served: async () => [teamApp],
            app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
          }),
        ),
      'test',
    );

  /** The owner's files named `name`: id, folder, home, indexing, bytes. */
  const found = async (name: string) =>
    x<{ id: string; path: string; home: string | null; indexing: string | null; sha: string }>(
      sql`select id::text, path::text, home_ws::text as home, data->>'indexing' as indexing,
                 data->>'sha256' as sha
            from nodes where owner_id = ${owner} and type = 'file' and data->>'filename' = ${name}`,
    );

  const b64 = (s: string) => Buffer.from(s).toString('base64');

  /** Set an item's grants: [workspace, write, home]. */
  const grants = async (id: string, rows: [string, boolean, boolean][]) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      for (const [ws, write, home] of rows) {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${id}, ${ws}, ${write}, ${home})`);
      }
    });

  beforeAll(async () => {
    savedEnv.MANTLE_ACTOR_CHECK = process.env.MANTLE_ACTOR_CHECK;
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'team-app-files-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    t = await import('@mantle/tools');
    files = await import('@mantle/files');
    broker = await import('@/lib/app-tool-broker');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${member}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'Member'),
      (${moderator}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    holderWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Holder`}) returning id::text`)
    )[0]!.id;
    otherWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Other`}) returning id::text`)
    )[0]!.id;
    elseWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Else`}) returning id::text`)
    )[0]!.id;
    await su(sql`delete from workspace_users where login_id in (${member}, ${moderator})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${holderWs}, ${member}, false),
      (${holderWs}, ${moderator}, true),
      (${elseWs}, ${member}, false),
      (${elseWs}, ${moderator}, false)`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    // An enabled team-level group holds the tools (rule 5).
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${owner}, ${`${tag}-files`}, 'Files', ${`{${SLUGS.join(',')}}`}::text[], 'team', true)`);

    // The folders and an Admin file, made as system work, then granted.
    await m.asSystem(async () => {
      await files.ensureFilesRootBranch(owner);
      const folder = async (slug: string, rows: [string, boolean, boolean][]) => {
        const f = await m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, () =>
          files.createFolder({ ownerId: owner, parentPath: 'files', slug }),
        );
        await grants(f.id, rows);
        return f.path;
      };
      open = await folder(`${tag}-open`, [[holderWs, true, true]]);
      closed = await folder(`${tag}-closed`, [[holderWs, false, true]]);
      shared = await folder(`${tag}-shared`, [
        [holderWs, true, true],
        [otherWs, false, false],
      ]);
      both = await folder(`${tag}-both`, [
        [holderWs, true, true],
        [elseWs, false, false],
      ]);
      both2 = await folder(`${tag}-both2`, [
        [holderWs, true, true],
        [elseWs, false, false],
      ]);
      elsewhere = await folder(`${tag}-elsewhere`, [[elseWs, true, true]]);
      adminFolder = await folder(`${tag}-admin`, [[adminWs, true, true]]);
      adminFile = (
        await m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, () =>
          files.upsertFile({
            ownerId: owner,
            parentPath: adminFolder,
            filename: `${tag}-admin.txt`,
            bytes: Buffer.from('admin only'),
          }),
        )
      ).id;
      bothFile = (
        await m.withCreateHome({ createWs: holderWs, privateWs: null, quiet: true }, () =>
          files.upsertFile({
            ownerId: owner,
            parentPath: both,
            filename: `${tag}-both.dwg`,
            bytes: Buffer.from('read by two workspaces'),
          }),
        )
      ).id;
    }, 'test');

    const app = async (holds: [string, boolean, boolean][]) => {
      const id = randomUUID();
      await x(sql`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
      await x(sql`insert into apps (node_id, manifest)
        values (${id}, ${JSON.stringify({ toolSlugs: SLUGS })}::jsonb)`);
      await grants(id, holds);
      return id;
    };
    teamApp = await app([
      [holderWs, true, true],
      [adminWs, false, false],
    ]);
    twoHolderApp = await app([
      [holderWs, true, true],
      [otherWs, false, false],
    ]);

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** An item check's or a missing item's refusal, as the tools word it. */
  const NO_RIGHT = /not allowed|cannot change|Write on it|Moderator|not found/i;

  /** The workspaces that read the file `id` now. */
  const readers = async (id: string) =>
    (await x<{ ws: string[] }>(sql`select read_ws::text[] as ws from nodes where id = ${id}`))[0]!
      .ws;

  it("1. a user with Write on the folder uploads: homed in the folder's home, read as a Files upload, logged by name", async () => {
    access.mockClear();
    const name = `${tag}-iso-1.dwg`;
    const res = await memberCall(member, 'file_upload', {
      parent_path: open,
      filename: name,
      content_base64: b64('AC1032 drawing rev A'),
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const rows = await found(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: open, home: holderWs, indexing: null });
    // One Activity row: the folder and the file, never the bytes.
    const detail = access.mock.calls.at(-1)?.[0]?.detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      slug: 'file_upload',
      write: true,
      file: { folder: open, filename: name },
    });
    expect(JSON.stringify(detail)).not.toContain(b64('AC1032 drawing rev A'));
  });

  it('2. a Moderator replaces it: the same file, the new bytes', async () => {
    const name = `${tag}-iso-1.dwg`;
    const [before] = await found(name);
    const res = await memberCall(moderator, 'file_upload', {
      parent_path: open,
      filename: name,
      content_base64: b64('AC1032 drawing rev B'),
      overwrite: true,
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const [after] = await found(name);
    expect(after!.id).toBe(before!.id);
    expect(after!.sha).not.toBe(before!.sha);
    expect(after!.home).toBe(holderWs);
  });

  it('3. a user without Write on the folder: refused, nothing lands', async () => {
    const name = `${tag}-iso-3.dwg`;
    const res = await memberCall(member, 'file_upload', {
      parent_path: closed,
      filename: name,
      content_base64: b64('x'),
    });
    expect(res.body.ok).toBe(false);
    expect(await found(name)).toHaveLength(0);
    // The Moderator may: the folder's home is theirs.
    const mod = await memberCall(moderator, 'file_upload', {
      parent_path: closed,
      filename: name,
      content_base64: b64('x'),
    });
    expect(mod.body.ok, JSON.stringify(mod.body)).toBe(true);
    expect((await found(name))[0]?.home).toBe(holderWs);
  });

  it('4. a folder homed in Admin, or the files root: refused where it runs', async () => {
    for (const parent of [adminFolder, 'files']) {
      const name = `${tag}-iso-4.txt`;
      const res = await memberCall(moderator, 'file_upload', {
        parent_path: parent,
        filename: name,
        content_text: 'x',
      });
      expect(res.body.ok, JSON.stringify(res.body)).toBe(false);
      expect(res.body.error).toMatch(NO_RIGHT);
      expect(await found(name)).toHaveLength(0);
    }
  });

  it('5. a folder another workspace reads: it lands, read there too; confirm: true never passes', async () => {
    const name = `${tag}-iso-5.txt`;
    const confirmed = await memberCall(moderator, 'file_upload', {
      parent_path: shared,
      filename: name,
      content_text: 'x',
      confirm: true,
    });
    expect(confirmed.status).toBe(403);
    expect(confirmed.body.error).toContain('confirm: true');
    expect(await found(name)).toHaveLength(0);
    const res = await memberCall(member, 'file_upload', {
      parent_path: shared,
      filename: name,
      content_text: 'x',
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const [row] = await found(name);
    expect(row).toMatchObject({ path: shared, home: holderWs });
    expect(await readers(row!.id)).toEqual(expect.arrayContaining([holderWs, otherWs]));
  });

  it('6. past 16 MB: refused before the write', async () => {
    const name = `${tag}-iso-6.bin`;
    const res = await memberCall(moderator, 'file_upload', {
      parent_path: open,
      filename: name,
      content_base64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('16.0 MB');
    expect(await found(name)).toHaveLength(0);
    // Past the 8 MB JSON cap but within 16 MB of file: it lands.
    const big = `${tag}-iso-6-big.dwg`;
    const ok = await memberCall(moderator, 'file_upload', {
      parent_path: open,
      filename: big,
      content_base64: Buffer.alloc(10 * 1024 * 1024, 7).toString('base64'),
    });
    expect(ok.body.ok, JSON.stringify(ok.body).slice(0, 300)).toBe(true);
    expect((await found(big))[0]?.home).toBe(holderWs);
    // Any other call past 8 MB answers the cap's 413, as it always did.
    const list = await memberCall(moderator, 'file_list', {
      pad: 'a'.repeat(9 * 1024 * 1024),
    });
    expect(list.status).toBe(413);
    // Content that is not a string is no file's bytes: refused, not counted
    // as nothing and written whole.
    const array = await memberCall(moderator, 'file_upload', {
      parent_path: open,
      filename: name,
      content_text: ['a', 'b'],
    });
    expect(array.body.ok).toBe(false);
    expect(array.body.error).toContain('content_text must be a string');
    // Its folder decides the indexing, never the app.
    const indexed = await memberCall(moderator, 'file_upload', {
      parent_path: open,
      filename: name,
      content_text: 'x',
      indexing: 'full',
    });
    expect(indexed.body.ok).toBe(false);
    expect(indexed.body.error).toContain('leave indexing out');
    expect(await found(name)).toHaveLength(0);
  });

  it('7. a move: a Moderator lands it; a user who is not one, into a folder another workspace reads, or into Admin, is refused', async () => {
    const [file] = await found(`${tag}-iso-1.dwg`);
    const byMember = await memberCall(member, 'file_move', {
      file_id: file!.id,
      dest_path: closed,
    });
    expect(byMember.body.ok).toBe(false);
    expect(byMember.body.error).toMatch(NO_RIGHT);
    expect((await found(`${tag}-iso-1.dwg`))[0]?.path).toBe(open);
    const byModerator = await memberCall(moderator, 'file_move', {
      file_id: file!.id,
      dest_path: closed,
    });
    expect(byModerator.body.ok, JSON.stringify(byModerator.body)).toBe(true);
    expect((await found(`${tag}-iso-1.dwg`))[0]).toMatchObject({ path: closed, home: holderWs });
    // An existing file moved where another workspace would start reading
    // it: a change of who sees it, which a team app never confirms.
    const intoShared = await memberCall(moderator, 'file_move', {
      file_id: file!.id,
      dest_path: shared,
    });
    expect(intoShared.body.ok).toBe(false);
    expect(intoShared.body.error).toContain('A team app never changes who can see a file');
    expect((await found(`${tag}-iso-1.dwg`))[0]?.path).toBe(closed);
    expect(await readers(file!.id)).not.toContain(otherWs);
    const intoAdmin = await memberCall(moderator, 'file_move', {
      file_id: file!.id,
      dest_path: adminFolder,
    });
    expect(intoAdmin.body.ok).toBe(false);
    expect(intoAdmin.body.error).toMatch(/who can see a file|not allowed|cannot change|no folder/i);
    expect((await found(`${tag}-iso-1.dwg`))[0]?.path).toBe(closed);
  });

  it('7b. a move that would stop a workspace reading the file: refused; between folders the same workspaces read: it lands', async () => {
    expect(await readers(bothFile)).toContain(elseWs);
    const out = await memberCall(moderator, 'file_move', { file_id: bothFile, dest_path: open });
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toContain('A team app never changes who can see a file');
    expect((await found(`${tag}-both.dwg`))[0]?.path).toBe(both);
    expect(await readers(bothFile)).toContain(elseWs);
    const along = await memberCall(moderator, 'file_move', { file_id: bothFile, dest_path: both2 });
    expect(along.body.ok, JSON.stringify(along.body)).toBe(true);
    expect((await found(`${tag}-both.dwg`))[0]?.path).toBe(both2);
    expect(await readers(bothFile)).toContain(elseWs);
  });

  it("8. a rename of the runner's file lands; of an Admin file, refused", async () => {
    const [file] = await found(`${tag}-iso-1.dwg`);
    const res = await memberCall(moderator, 'file_rename', {
      file_id: file!.id,
      new_stem: `${tag}-iso-1-rev-b`,
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(await found(`${tag}-iso-1-rev-b.dwg`)).toHaveLength(1);
    const admin = await memberCall(moderator, 'file_rename', {
      file_id: adminFile,
      new_stem: `${tag}-taken`,
    });
    expect(admin.body.ok).toBe(false);
    expect(admin.body.error).toMatch(/not found|not allowed|cannot change/i);
    expect(await found(`${tag}-taken.txt`)).toHaveLength(0);
  });

  it('9. a read-only login and a shared link write nothing; an app two workspaces hold writes as its runner', async () => {
    const name = `${tag}-iso-9.txt`;
    const input = { parent_path: open, filename: name, content_text: 'x' };
    const ro = await memberCall(moderator, 'file_upload', input, { mode: 'ro' });
    expect(ro.body.ok).toBe(false);
    const link = await linkCall('file_upload', input);
    expect(link.status).toBe(403);
    expect(await found(name)).toHaveLength(0);
    const two = await memberCall(moderator, 'file_upload', input, {}, twoHolderApp);
    expect(two.body.ok, JSON.stringify(two.body)).toBe(true);
    expect((await found(name))[0]).toMatchObject({ path: open, home: holderWs });
  });

  it('11. by hand (no app), a new file in a folder another workspace reads still asks first', async () => {
    const { guardNewFileIn, TreeVisibilityError } = await import('@mantle/content/tree');
    await expect(
      inRequest(moderator, () => guardNewFileIn(owner, shared, `${tag}-by-hand.txt`, {})),
    ).rejects.toBeInstanceOf(TreeVisibilityError);
    await expect(
      inRequest(moderator, () =>
        guardNewFileIn(owner, shared, `${tag}-by-hand.txt`, { confirm: true }),
      ),
    ).resolves.toMatchObject({ total: 1 });
  });

  it("10. a folder of a workspace the runner is in, not the app's holder: it lands there", async () => {
    const name = `${tag}-iso-10.dwg`;
    const res = await memberCall(member, 'file_upload', {
      parent_path: elsewhere,
      filename: name,
      content_base64: b64('elsewhere'),
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect((await found(name))[0]).toMatchObject({ path: elsewhere, home: elseWs });
  });
});

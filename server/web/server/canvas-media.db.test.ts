/**
 * Canvas media from Files (task a265178d): which files a canvas may play,
 * on one migrated scratch database switched to workspaces, with the actor
 * check and the edit check on, through the real routes (runRoute) and the
 * assistant turn:
 *
 *  - a save keeps only the declared files the SAVER reads, in its own
 *    scope, and says plainly which it left out, also when an editor's save
 *    takes out a file an earlier author declared (plan section 2);
 *  - a malformed declaration refuses the save, nothing written;
 *  - a save says which declared files some readers cannot read, and which
 *    sit outside the canvas's workspace (decisions 5 and 7);
 *  - the owner frame ticket names the declared ids; present_get names a
 *    declared file only to a caller who reads it (no file names leak);
 *  - an open link serves the canvas's media with no switch (a canvas's
 *    media is part of it, as a page's images): the list its last save made
 *    for the link (`meta.linkAssets`), the declared files of the canvas's
 *    own workspace that the saver may edit, and nothing else (an Admin
 *    file, a document, an undeclared file, one a later save took out, a
 *    file the saver may only read, task 71285cd1 M1), each as the same 404;
 *    a later move into the workspace serves nothing until a save, a move
 *    out stops at once (M2); bytes that are not their type, a snapshot
 *    copy, a missing or too large size, a closed or expired link: 404;
 *    a contact share never serves one; the link's frame ticket names the
 *    link's list.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/canvas-media.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** A canvas declaring `ids` for mantle.media. */
const canvas = (title: string, ids: string[]) =>
  `<!doctype html><html><head><title>${title}</title><meta name="canvas:assets" content="${ids.join(' ')}"></head><body><p>${title}</p></body></html>`;

describe.skipIf(!URL)('canvas media: declared files, the save check and the open link', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let presents: typeof import('@mantle/content/presents');
  let content: typeof import('@mantle/content');
  let tools: typeof import('@mantle/tools');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `cm${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A Moderator of W (a member login). The owner, an Admin user, is a
   *  Moderator of W too: the link routes are Admin routes. */
  const mod = randomUUID();
  /** A plain user of W. */
  const user = randomUUID();
  const ws = { admin: '', w: '' };
  const file = { w: '', w2: '', admin: '', pdf: '' };
  let cv = '';
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:canvas-media', fn) as Promise<T>;

  /** Home `id` in `home` alone (Write for its users when `write`). */
  const homeIn = async (id: string, home: string, write = false) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${id} and via_folder_id is null`,
      );
      await tx.execute(sql`update item_grants set excluded = true, is_home = false, write = false
                           where node_id = ${id} and workspace_id <> ${home}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
                           values (${id}, ${home}, ${write}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, write = ${write}, excluded = false,
                                         via_folder_id = null`);
    });
  };
  const fileIn = async (name: string, home: string, bytes = Buffer.from(`ID3 ${name} bytes`)) => {
    const r = await sys(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: `files.${tag}`,
        filename: name,
        bytes,
      }),
    );
    await homeIn(r.id, home);
    return r.id.toLowerCase();
  };
  const assetsOf = async (id: string) =>
    (
      await su<{ a: string[] | null }>(
        sql`select meta->'assets' as a from presents where node_id = ${id}`,
      )
    )[0]?.a ?? null;
  const linkOf = async (id: string) =>
    (
      await su<{ a: string[] | null }>(
        sql`select meta->'linkAssets' as a from presents where node_id = ${id}`,
      )
    )[0]?.a ?? null;
  const revOf = async (id: string) =>
    (await su<{ r: number }>(sql`select rev as r from presents where node_id = ${id}`))[0]!.r;
  /** Save `source` as the system (it reads every file). */
  const systemSave = (source: string) =>
    sys(() => presents.savePresentSource(owner, cv, { source, css: '' }));
  const route = async (login: string | null, method: string, url: string, body?: unknown) => {
    const res = await runRoute(login, method, url, body);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json, type: res.headers.get('content-type') };
  };

  const builtin = (slug: string) =>
    ({
      slug,
      name: slug,
      description: slug,
      handler: { kind: 'builtin', ref: slug },
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      externalAccess: null,
    }) as unknown as Tool;
  /** One tool call from W's assistant turn answering `login`. */
  const turn = (login: string, slug: string, input: Record<string, unknown>) =>
    m.withTurnScope(
      { kind: 'assistant', loginId: login, ws: [ws.w], modWs: login === mod ? [ws.w] : [] },
      () =>
        tools.dispatchTool(builtin(slug), input, {
          caller: tools.turnCaller(),
          ownerId: owner,
          surface: { kind: 'team', loginId: login },
        }),
      { writes: true },
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'canvas-media-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'canvas-media-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    // No renderer, no outside: a save says it was not drawn.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    presents = await import('@mantle/content/presents');
    content = await import('@mantle/content');
    tools = await import('@mantle/tools');
    runRoute = (await import('./run-route')).runRoute;
    // Fixtures through the test's own superuser client, never the app's pool.
    await su(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mod}, ${`${tag}-mod@example.invalid`}, 'x', false, 'member', 'Mod'),
      (${user}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User')`);
    await su(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    ws.admin = (
      await su<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin`)
    )[0]!.id;
    ws.w = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} W`}) returning id::text as id`)
    )[0]!.id;
    await su(sql`delete from workspace_users where workspace_id = ${ws.w}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${mod}, true), (${ws.w}, ${user}, false), (${ws.w}, ${owner}, true)`);
    for (const login of [mod, user]) {
      await su(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)`,
      );
    }

    await sys(() => f.ensureFilesRootBranch(owner));
    const folder = await sys(() =>
      f.createFolder({ ownerId: owner, parentPath: 'files', slug: tag }),
    );
    await homeIn(folder.id, ws.w);
    file.w = await fileIn('w.mp3', ws.w);
    file.w2 = await fileIn('w2.mp3', ws.w);
    file.admin = await fileIn('admin-secret-name.mp3', ws.admin);
    file.pdf = await fileIn('report.pdf', ws.w);
    const made = await sys(() =>
      m.withCreateHome({ createWs: ws.w, privateWs: null, quiet: true }, () =>
        presents.createPresent(owner, { source: canvas(`${tag} canvas`, []), css: '' }),
      ),
    );
    cv = made.id;
    await homeIn(cv, ws.w, true);

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a save keeps only the declared files the saver reads, and says which it left out', async () => {
    const stranger = randomUUID();
    const r = await route(user, 'PATCH', `/api/presents/${cv}`, {
      source: canvas(`${tag} user save`, [file.w, file.admin, stranger]),
    });
    expect(r.status, r.text).toBe(200);
    expect(await assetsOf(cv)).toEqual([file.w]);
    // A plain user reads W's files, and may not edit them: none goes on the
    // link's list (M1).
    expect(await linkOf(cv)).toEqual([]);
    const said = (r.json.assetProblems as string[]).join(' ');
    expect(said).toContain('2 declared file id(s) are not files you can read');
    expect(said).toContain(`You may not edit ${file.w}, so an open link does not serve them`);
    expect(said).toContain(stranger);
    // The Admin file's id is said (the saver wrote it), never its name.
    expect(said).not.toContain('admin-secret-name');
  });

  it("an editor's save that cannot read an earlier author's file takes it out, and says so", async () => {
    const source = canvas(`${tag} both`, [file.w, file.admin]);
    const first = await systemSave(source);
    expect(first.ok).toBe(true);
    expect(await assetsOf(cv)).toEqual([file.w, file.admin]);
    if (first.ok) {
      const said = first.present.assetProblems.join(' ');
      // Decision 5: W's readers cannot read the Admin file. Decision 7: an
      // open link never serves it.
      expect(said).toContain('Some readers of this canvas cannot read');
      expect(said).toContain("outside the canvas's own workspace");
    }
    const r = await route(user, 'PATCH', `/api/presents/${cv}`, {
      source: canvas(`${tag} both again`, [file.w, file.admin]),
    });
    expect(r.status, r.text).toBe(200);
    expect(await assetsOf(cv)).toEqual([file.w]);
    expect((r.json.assetProblems as string[]).join(' ')).toContain(
      'This save took out 1 file(s) an earlier save declared',
    );
  });

  it('a malformed declaration refuses the save, nothing written', async () => {
    const rev = await revOf(cv);
    const r = await route(user, 'PATCH', `/api/presents/${cv}`, {
      source: canvas(`${tag} bad`, [file.w, 'not-a-file-id']),
    });
    expect(r.status).toBe(400);
    expect(r.text).toContain('not-a-file-id');
    expect(await revOf(cv)).toBe(rev);
    const tool = await turn(user, 'present_update', {
      id: cv,
      source: canvas(`${tag} bad tool`, ['nope']),
      look: false,
    });
    expect(tool.ok).toBe(false);
    expect(await revOf(cv)).toBe(rev);
  });

  it('the owner frame ticket names the declared ids; present_get names only readable files', async () => {
    await systemSave(canvas(`${tag} ticket`, [file.w, file.admin]));
    const t = await route(user, 'POST', `/api/presents/${cv}/frame-ticket`, {});
    expect(t.status, t.text).toBe(200);
    expect(t.json.assets).toEqual([file.w, file.admin]);

    const got = await turn(user, 'present_get', { id: cv, source: false });
    expect(got.ok).toBe(true);
    const assets = (got as { output: { assets: Array<Record<string, unknown>> } }).output.assets;
    expect(assets[0]).toMatchObject({ id: file.w, filename: 'w.mp3', mime: 'audio/mpeg' });
    expect(assets[1]).toEqual({ id: file.admin, readable: false });
    expect(JSON.stringify(got)).not.toContain('admin-secret-name');
  });

  describe("an open link serves the canvas's media", () => {
    let share: Awaited<ReturnType<(typeof import('@mantle/content'))['createShare']>>;
    const asset = (id: string) => route(null, 'GET', `/s/${share.token}/a/${id}`);
    const ticketAssets = async () =>
      (await route(null, 'POST', `/s/${share.token}/canvas/frame-ticket`, {})).json.assets;
    const fileData = (id: string, set: ReturnType<typeof sql>) =>
      su(sql`update nodes set data = ${set} where id = ${id}`);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('a picture'),
    ]);
    const extra = { png: '', fakePng: '', copy: '' };

    beforeAll(async () => {
      // A real png, and a sound renamed to .png (its type comes from the name).
      extra.png = await fileIn('real.png', ws.w, png);
      extra.fakePng = await fileIn('fake.png', ws.w);
      extra.copy = await fileIn('copy.mp3', ws.w);
      await systemSave(canvas(`${tag} link`, [file.w, file.admin, file.pdf]));
      share = await sys(() => content.createShare(owner, cv, {}));
    });

    it('a declared file of the canvas workspace, with no switch, and nothing else', async () => {
      const ok = await asset(file.w);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.type).toBe('audio/mpeg');
      const t = await route(null, 'POST', `/s/${share.token}/canvas/frame-ticket`, {});
      expect(t.status, t.text).toBe(200);
      // The link's list: the Admin file is declared, and never on it.
      expect(t.json.assets).toEqual([file.w, file.pdf]);
      // Declared but an Admin file (decision 7), declared but not a media
      // type (a document is never handed out by its id), undeclared, a
      // random id: the same 404.
      const admin = await asset(file.admin);
      const pdf = await asset(file.pdf);
      expect(pdf.status).toBe(404);
      expect(pdf.text).toBe(admin.text);
      const undeclared = await asset(file.w2);
      const random = await asset(randomUUID());
      expect([admin.status, undeclared.status, random.status]).toEqual([404, 404, 404]);
      expect(admin.text).toBe(random.text);
    });

    it('a contact share never serves a canvas file', async () => {
      const { isAssetAllowed } = await import('@/lib/shares');
      const row = (
        await su<Record<string, unknown>>(sql`select * from shares where id = ${share.id}`)
      )[0]!;
      const asShare = {
        ...(row as object),
        ownerId: owner,
        nodeId: cv,
        nodeType: 'present',
      } as never;
      expect(await isAssetAllowed(asShare, file.w)).toBe(true);
      expect(
        await isAssetAllowed({ ...(asShare as object), contactId: randomUUID() } as never, file.w),
      ).toBe(false);
    });

    it('a save that takes a file out: the next fetch is refused', async () => {
      expect((await asset(file.w)).status).toBe(200);
      await systemSave(canvas(`${tag} link`, [file.admin]));
      expect((await asset(file.w)).status).toBe(404);
      expect(await ticketAssets()).toEqual([]);
    });

    it('a file the saver may only read is not served; a save by one who may edit it serves it (M1)', async () => {
      const source = canvas(`${tag} m1`, [file.w]);
      const r = await route(user, 'PATCH', `/api/presents/${cv}`, { source });
      expect(r.status, r.text).toBe(200);
      expect(await assetsOf(cv)).toEqual([file.w]);
      expect(await linkOf(cv)).toEqual([]);
      expect((await asset(file.w)).status).toBe(404);
      expect(await ticketAssets()).toEqual([]);
      // A Moderator of W may edit the file: the same canvas, saved by it.
      const again = await route(mod, 'PATCH', `/api/presents/${cv}`, {
        source: canvas(`${tag} m1 mod`, [file.w]),
      });
      expect(again.status, again.text).toBe(200);
      expect(await linkOf(cv)).toEqual([file.w]);
      expect((await asset(file.w)).status).toBe(200);
      expect(await ticketAssets()).toEqual([file.w]);
      // As a page's list: the user's next save keeps what is on it (keeping
      // needs no more than the save), and adds nothing the user may only read.
      const keep = await route(user, 'PATCH', `/api/presents/${cv}`, {
        source: canvas(`${tag} m1 typo`, [file.w, file.w2]),
      });
      expect(keep.status, keep.text).toBe(200);
      expect(await assetsOf(cv)).toEqual([file.w, file.w2]);
      expect(await linkOf(cv)).toEqual([file.w]);
      expect((await asset(file.w)).status).toBe(200);
      expect((await asset(file.w2)).status).toBe(404);
      expect((keep.json.assetProblems as string[]).join(' ')).toContain(
        `You may not edit ${file.w2}`,
      );
    });

    it('a canvas moved to another workspace stops its media, even with its files (audit LOW-2)', async () => {
      await systemSave(canvas(`${tag} canvas move`, [file.w]));
      expect((await asset(file.w)).status).toBe(200);
      // The canvas and its file both move to Admin: the list was made in W.
      await sys(() => homeIn(cv, ws.admin, true));
      await sys(() => homeIn(file.w, ws.admin));
      try {
        expect((await asset(file.w)).status).toBe(404);
      } finally {
        await sys(() => homeIn(file.w, ws.w));
        await sys(() => homeIn(cv, ws.w, true));
      }
      expect((await asset(file.w)).status).toBe(200);
    });

    it('a later move into the workspace serves nothing until a save; a move out stops at once (M2)', async () => {
      await systemSave(canvas(`${tag} m2`, [file.w, file.admin]));
      expect(await linkOf(cv)).toEqual([file.w]);
      // The Admin file moves into W: still not served, the save did not list it.
      await sys(() => homeIn(file.admin, ws.w));
      try {
        expect((await asset(file.admin)).status).toBe(404);
        await systemSave(canvas(`${tag} m2 again`, [file.w, file.admin]));
        expect(await linkOf(cv)).toEqual([file.w, file.admin]);
        expect((await asset(file.admin)).status).toBe(200);
      } finally {
        await sys(() => homeIn(file.admin, ws.admin));
      }
      // Moved back out: the next fetch is refused, the list unchanged.
      expect((await asset(file.admin)).status).toBe(404);
      await sys(() => homeIn(file.w, ws.admin));
      try {
        expect((await asset(file.w)).status).toBe(404);
      } finally {
        await sys(() => homeIn(file.w, ws.w));
      }
      expect((await asset(file.w)).status).toBe(200);
    });

    it('only bytes of their own type, a stored size within the cap, not a snapshot copy', async () => {
      await systemSave(canvas(`${tag} bytes`, [extra.png, extra.fakePng, extra.copy]));
      expect(await linkOf(cv)).toEqual([extra.png, extra.fakePng, extra.copy]);
      const real = await asset(extra.png);
      expect(real.status, real.text).toBe(200);
      expect(real.type).toBe('image/png');
      // A sound stored as image/png by its name: not handed out as a picture.
      expect((await asset(extra.fakePng)).status).toBe(404);

      const [row] = await su<{ data: Record<string, unknown> }>(
        sql`select data from nodes where id = ${extra.png}`,
      );
      const data = row!.data;
      try {
        await fileData(
          extra.png,
          sql`${JSON.stringify({ ...data, size_bytes: 20 * 1024 * 1024 })}::jsonb`,
        );
        expect((await asset(extra.png)).status).toBe(404);
        const { size_bytes: _gone, ...unsized } = data;
        await fileData(extra.png, sql`${JSON.stringify(unsized)}::jsonb`);
        expect((await asset(extra.png)).status).toBe(404);
      } finally {
        await fileData(extra.png, sql`${JSON.stringify(data)}::jsonb`);
      }
      expect((await asset(extra.png)).status).toBe(200);

      // A snapshot copy is never served, though the list holds it (one way:
      // the database keeps a copy read-only, so the mark stays).
      expect((await asset(extra.copy)).status).toBe(200);
      await su(
        sql`update nodes set data = data || '{"snapshot_of":"x"}'::jsonb where id = ${extra.copy}`,
      );
      expect((await asset(extra.copy)).status).toBe(404);
    });

    it('a closed or expired link serves nothing', async () => {
      await systemSave(canvas(`${tag} closed`, [file.w]));
      expect((await asset(file.w)).status).toBe(200);
      await su(
        sql`update shares set expires_at = now() - interval '1 minute' where id = ${share.id}`,
      );
      expect((await asset(file.w)).status).toBe(404);
      expect((await route(null, 'POST', `/s/${share.token}/canvas/frame-ticket`, {})).status).toBe(
        404,
      );
      await su(sql`update shares set expires_at = null, revoked_at = now() where id = ${share.id}`);
      expect((await asset(file.w)).status).toBe(404);
    });
  });
});

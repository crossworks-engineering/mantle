/**
 * The canvas data store (DWG phase 7a) follows the canvas's item rights. On
 * one migrated scratch database, switched to workspaces, with the actor
 * check and the edit check on, through the full HTTP pipeline (runRoute)
 * and an assistant turn (present_get with `data`):
 *
 *  - `shared`: every reader reads; a write asks Write on the canvas (a
 *    Moderator of its home, or a Write grant); a reader without Write is
 *    refused (403) and nothing is written;
 *  - `mine`: any reader writes and reads their own entries only; a user with
 *    Write on the canvas lists everyone's (`everyone=1`), a plain reader is
 *    refused; the row rule (0335) shows a plain reader's scope no other
 *    login's entry;
 *  - a login that does not read the canvas gets 404 and writes nothing;
 *  - the caps: a value over 64 KB is a 400; past the canvas's 1 MB, or a
 *    login's own 200 entries, a new key is a 413 (a replace of an existing
 *    key still fits);
 *  - a data write never changes the canvas (its rev and source stay);
 *  - an agent reads the store with present_get `data`, with the same rights.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/canvas-data-rights.db.test.ts
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

const canvas = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

describe.skipIf(!URL)('the canvas data store follows the canvas rights', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let presents: typeof import('@mantle/content/presents');
  let tools: typeof import('@mantle/tools');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `cvd${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A Moderator of W. */
  const mod = randomUUID();
  /** A plain user of W. */
  const user = randomUUID();
  /** A member with no seat in W. */
  const other = randomUUID();
  const ws = { w: '' };
  /** Homed in W: Write for its plain users, and without. */
  const cv = { write: '', noWrite: '' };
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const canvasIn = async (home: string, title: string, write: boolean) => {
    const row = await m.asSystem(
      () =>
        m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, () =>
          presents.createPresent(owner, { source: canvas(`${tag} ${title}`), css: '' }),
        ),
      'test',
    );
    await m.withHeads([row.id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${row.id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${row.id}, ${home}, ${write}, true)`);
    });
    return row.id;
  };

  const route = async (login: string, method: string, url: string, body?: unknown) => {
    const res = await runRoute(login, method, url, body);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  };
  const base = (id: string) => `/api/presents/${id}/data`;
  const put = (login: string, id: string, bucket: string, key: string, value: unknown) =>
    route(login, 'PUT', base(id), { bucket, key, value });
  const rows = async (id: string) =>
    x<{ bucket: string; key: string; login_id: string | null }>(sql`
      select bucket, key, login_id::text as login_id from canvas_data
       where node_id = ${id} order by bucket, key, login_id`);

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
  const turn = (login: string, modWs: string[], slug: string, input: Record<string, unknown>) =>
    m.withTurnScope(
      { kind: 'assistant', loginId: login, ws: [ws.w], modWs },
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
    dir = await mkdtemp(path.join(tmpdir(), 'canvas-data-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'canvas-data-rights-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    presents = await import('@mantle/content/presents');
    tools = await import('@mantle/tools');
    runRoute = (await import('./run-route')).runRoute;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mod}, ${`${tag}-mod@example.invalid`}, 'x', false, 'member', 'Mod'),
      (${user}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User'),
      (${other}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    ws.w = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} W`}) returning id::text as id`)
    )[0]!.id;
    await su(sql`delete from workspace_users where workspace_id = ${ws.w}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${mod}, true), (${ws.w}, ${user}, false)`);
    for (const login of [mod, user, other]) {
      await x(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)`,
      );
    }
    cv.write = await canvasIn(ws.w, 'write', true);
    cv.noWrite = await canvasIn(ws.w, 'no write', false);

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

  it('shared: a Moderator and a Write grant write it; a reader without Write reads it and is refused', async () => {
    const byMod = await put(mod, cv.noWrite, 'shared', 'layout', { zoom: 2 });
    expect(byMod.status, byMod.text).toBe(200);
    const byWrite = await put(user, cv.write, 'shared', 'layout', { zoom: 3 });
    expect(byWrite.status, byWrite.text).toBe(200);

    const refused = await put(user, cv.noWrite, 'shared', 'layout', { zoom: 9 });
    expect(refused.status, refused.text).toBe(403);
    const read = await route(user, 'GET', `${base(cv.noWrite)}?bucket=shared&key=layout`);
    expect(read.status, read.text).toBe(200);
    expect((read.json.entry as { value: unknown }).value).toEqual({ zoom: 2 });
    const del = await route(user, 'DELETE', `${base(cv.noWrite)}?bucket=shared&key=layout`);
    expect(del.status).toBe(403);
    expect(await rows(cv.noWrite)).toEqual([{ bucket: 'shared', key: 'layout', login_id: null }]);
  });

  it("mine: every reader writes its own; only Write lists everyone's", async () => {
    expect((await put(user, cv.noWrite, 'mine', 'vote', 'yes')).status).toBe(200);
    expect((await put(mod, cv.noWrite, 'mine', 'vote', 'no')).status).toBe(200);

    const own = await route(user, 'GET', `${base(cv.noWrite)}?bucket=mine`);
    expect(own.status).toBe(200);
    expect(own.json.entries).toEqual([
      expect.objectContaining({ key: 'vote', value: 'yes', by: { id: user, name: 'User' } }),
    ]);
    const notAll = await route(user, 'GET', `${base(cv.noWrite)}?bucket=mine&everyone=1`);
    expect(notAll.status).toBe(403);

    const all = await route(mod, 'GET', `${base(cv.noWrite)}?bucket=mine&everyone=1`);
    expect(all.status, all.text).toBe(200);
    const by = (all.json.entries as { by: { id: string } }[]).map((e) => e.by.id).sort();
    expect(by).toEqual([mod, user].sort());

    // The row rule alone: the plain user's scope sees no other login's entry.
    const seen = await m.withTurnScope(
      { kind: 'assistant', loginId: user, ws: [ws.w], modWs: [] },
      () =>
        m.db.execute(sql`select login_id::text as l from canvas_data
          where node_id = ${cv.noWrite} and bucket = 'mine'`),
    );
    expect((seen as unknown as { l: string }[]).map((r) => r.l)).toEqual([user]);

    // A delete takes the caller's own entry only.
    const gone = await route(user, 'DELETE', `${base(cv.noWrite)}?bucket=mine&key=vote`);
    expect(gone.json).toEqual({ ok: true, deleted: true });
    const left = await rows(cv.noWrite);
    expect(left.filter((r) => r.bucket === 'mine')).toEqual([
      { bucket: 'mine', key: 'vote', login_id: mod },
    ]);
  });

  it('a login that does not read the canvas gets 404 and writes nothing', async () => {
    const before = await rows(cv.noWrite);
    for (const r of [
      await route(other, 'GET', `${base(cv.noWrite)}?bucket=shared`),
      await route(other, 'GET', `${base(cv.noWrite)}?info=1`),
      await put(other, cv.noWrite, 'mine', 'x', 1),
      await put(other, cv.noWrite, 'shared', 'x', 1),
      await route(other, 'DELETE', `${base(cv.noWrite)}?bucket=mine&key=x`),
    ]) {
      expect(r.status, r.text).toBe(404);
    }
    expect(await rows(cv.noWrite)).toEqual(before);
  });

  it('info says what the reader may do', async () => {
    const plain = await route(user, 'GET', `${base(cv.noWrite)}?info=1`);
    expect(plain.json.info).toEqual({
      canWriteShared: false,
      readsEveryone: false,
      me: user,
      readOnly: false,
    });
    const writer = await route(user, 'GET', `${base(cv.write)}?info=1`);
    expect((writer.json.info as { canWriteShared: boolean }).canWriteShared).toBe(true);
  });

  it('refuses a bad request before anything is read', async () => {
    for (const body of [
      { bucket: 'others', key: 'a', value: 1 },
      { bucket: 'mine', key: '../a', value: 1 },
      { bucket: 'mine', key: 'a' },
      { bucket: 'mine', key: 'a', value: 'x'.repeat(70 * 1024) },
    ]) {
      const r = await route(user, 'PUT', base(cv.noWrite), body);
      expect([400, 413], JSON.stringify(body).slice(0, 60)).toContain(r.status);
    }
  });

  it('keeps the caps: a login’s own 200 entries, the canvas’s 1 MB', async () => {
    const id = await canvasIn(ws.w, 'caps', true);
    await x(sql`insert into canvas_data (node_id, bucket, key, login_id, value, bytes, updated_by)
      select ${id}::uuid, 'mine', 'k' || g, ${user}::uuid, '1'::jsonb, 1, ${user}::uuid
        from generate_series(1, 200) g`);
    expect((await put(user, id, 'mine', 'k201', 1)).status).toBe(413);
    expect((await put(user, id, 'mine', 'k1', 2)).status).toBe(200);
    // Another login still has room of its own.
    expect((await put(mod, id, 'mine', 'k1', 1)).status).toBe(200);

    await x(sql`insert into canvas_data (node_id, bucket, key, value, bytes, updated_by)
      values (${id}::uuid, 'shared', 'big', '"x"'::jsonb, ${1024 * 1024 - 300}, ${mod}::uuid)`);
    const full = await put(mod, id, 'shared', 'more', 'x'.repeat(400));
    expect(full.status, full.text).toBe(413);
    expect((await rows(id)).some((r) => r.key === 'more')).toBe(false);
  });

  it('a data write never changes the canvas', async () => {
    const [before] = await x<{ rev: number; source: string }>(
      sql`select rev, source from presents where node_id = ${cv.write}`,
    );
    expect((await put(user, cv.write, 'shared', 'marks', [1, 2, 3])).status).toBe(200);
    const [after] = await x<{ rev: number; source: string }>(
      sql`select rev, source from presents where node_id = ${cv.write}`,
    );
    expect(after).toEqual(before);
  });

  it('present_get `data` reads the store with the turn user’s rights', async () => {
    await put(user, cv.noWrite, 'mine', 'note', 'from user');
    const plain = (await turn(user, [], 'present_get', { id: cv.noWrite, data: true })) as {
      ok: boolean;
      output: { data: { shared: unknown[]; mine: { key: string }[]; everyone?: unknown[] } };
    };
    expect(plain.ok).toBe(true);
    expect(plain.output.data.shared.length).toBeGreaterThan(0);
    expect(plain.output.data.mine.map((e) => e.key)).toEqual(['note']);
    expect(plain.output.data.everyone).toBeUndefined();

    const moderator = (await turn(mod, [ws.w], 'present_get', { id: cv.noWrite, data: true })) as {
      ok: boolean;
      output: { data: { everyone?: { by: { id: string } }[] } };
    };
    expect(moderator.ok).toBe(true);
    const ids = new Set((moderator.output.data.everyone ?? []).map((e) => e.by.id));
    expect(ids.has(user)).toBe(true);

    // Without `data` nothing of the store is read.
    const bare = (await turn(user, [], 'present_get', { id: cv.noWrite })) as {
      output: Record<string, unknown>;
    };
    expect('data' in bare.output).toBe(false);
  });
});

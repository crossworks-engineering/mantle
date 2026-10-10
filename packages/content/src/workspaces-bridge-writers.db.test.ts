/**
 * The writers the level bridge (migration 0251) depends on, with the heads
 * check ON for the database (W4a re-audit 2): each takes its heads first, so
 * the bridge's own check passes, and the rows that follow from the change
 * (the embeds a save adds, a folder's inherited levels, the embeds a page
 * takes down with it) are locked by the bridge itself. Checked for a level
 * set (setItemAudience, setItemLevel), a folder share, page, note and
 * drawing saves that add an embed, and a new app. Also the connector bridge
 * (re-audit 3): Team's resource row follows a connector's level and switch.
 *
 * Runs on a scratch database of its own (migrated from scratch, dropped
 * after): the workspaces migration and the database-wide heads setting are
 * per database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/workspaces-bridge-writers.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Grant = { ws: string; excluded: boolean; home: boolean };

describe.skipIf(!URL)('level bridge writers hold their heads (heads check on)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-bridge-writers-'));
  const brain = randomUUID();
  const files: Record<string, string> = {};
  let team = '';
  let admin = '';

  const rows = async <T>(q: ReturnType<typeof import('drizzle-orm').sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const grants = async (id: string): Promise<Record<string, Grant>> => {
    const r = await rows<Grant & { name: string }>(sqlTag`
      select w.name, g.workspace_id::text as ws, g.excluded, g.is_home as home
        from item_grants g join workspaces w on w.id = g.workspace_id where g.node_id = ${id}`);
    return Object.fromEntries(r.map(({ name, ...g }) => [name, g]));
  };
  /** Whether Team reads the item (a Team row that is not "removed here"). */
  const teamReads = async (id: string) => {
    const g = await grants(id);
    return !!g.Team && !g.Team.excluded;
  };
  const misses = async () =>
    Number(
      (
        await rows<{ n: number }>(sqlTag`select count(*)::int as n from heads_check_misses
        where check_name <> 'bypass'`)
      )[0]!.n,
    );
  /** A file node row (no bytes), made with its folder's heads as a writer. */
  const file = async (key: string) => {
    const id = randomUUID();
    await m.withNodeInsertHeads(brain, [{ type: 'file', path: 'files' }], (tx) =>
      tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path, audience, data)
        values (${id}, ${brain}, 'file', ${key}, 'files', 'admin',
                ${JSON.stringify({ filename: `${key}.png`, mime_type: 'image/png' })}::jsonb)`),
    );
    files[key] = id;
    return id;
  };
  const fileEmbedDoc = (fileId: string) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'see the picture' }] },
      { type: 'fileEmbed', attrs: { nodeId: fileId } },
    ],
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb
      .execute(sqlTag`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${brain}, ${`bw-${brain.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await m.systemDb.execute(sqlTag`insert into spaces (id, kind, login_id)
      values (${brain}, 'brain', ${brain}) on conflict (id) do nothing`);
    await m.systemDb.execute(sqlTag`select * from mantle_ws_migrate()`);
    const ws = await rows<{ name: string; id: string }>(
      sqlTag`select name, id::text as id from workspaces where owner_id = ${brain}`,
    );
    admin = ws.find((w) => w.name === 'Admin')!.id;
    team = ws.find((w) => w.name === 'Team')!.id;
    // The check ON for this database: a writer without its heads is refused.
    await m.systemDb.execute(
      sqlTag.raw(`alter database "${scratch.name}" set mantle.heads_check = 'on'`),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('migrated, and the check is on', async () => {
    expect(admin && team).toBeTruthy();
    const mode = await rows<{ m: string }>(sqlTag`select mantle_heads_check_mode() as m`);
    expect(mode[0]!.m).toBe('on');
  });

  it('a page save that adds an embed, then the page lowered to team, takes the file along', async () => {
    const c = await import('./pages/tree');
    const d = await import('./pages/draft');
    const a = await import('./access');
    const f = await file('page-image');
    const page = await c.createPage(brain, { title: 'With a picture' });
    await d.updatePage(brain, page.id, { doc: fileEmbedDoc(f) });
    expect(await teamReads(f)).toBe(false);
    await a.setItemAudience(brain, page.id, 'team');
    expect(await teamReads(page.id)).toBe(true);
    expect(await teamReads(f)).toBe(true);
    // Back up, with the link path (setItemLevel).
    await a.setItemLevel(brain, page.id, 'admin');
    expect(await teamReads(page.id)).toBe(false);
  });

  it('a commit of a team page that adds an embed brings the file to team', async () => {
    const c = await import('./pages/tree');
    const d = await import('./pages/draft');
    const a = await import('./access');
    const page = await c.createPage(brain, { title: 'Team page' });
    await a.setItemAudience(brain, page.id, 'team');
    const f = await file('commit-image');
    const res = await d.commitPage(brain, page.id, fileEmbedDoc(f));
    expect(res.ok).toBe(true);
    expect(await teamReads(f)).toBe(true);
  });

  it('a team note that gains an image brings it to team', async () => {
    const n = await import('./notes');
    const a = await import('./access');
    const note = await n.createNote(brain, { title: 'Team note', content: 'plain' });
    await a.setItemAudience(brain, note.id, 'team');
    const f = await file('note-image');
    await n.updateNote(brain, note.id, { content: `look\n\n![pic](media:${f})\n` });
    expect(await teamReads(f)).toBe(true);
  });

  it('a team drawing whose commit places an image brings it to team', async () => {
    const dr = await import('./draws');
    const a = await import('./access');
    const draw = await dr.createDraw(brain, { title: 'Team drawing' });
    await a.setItemAudience(brain, draw.id, 'team');
    const f = await file('draw-image');
    const scene = {
      type: 'excalidraw',
      elements: [{ id: 'el1', type: 'image', fileId: 'img1', x: 0, y: 0, width: 10, height: 10 }],
      appState: {},
      files: {},
    };
    const res = await dr.commitDraw(brain, draw.id, scene, { fileRefs: { img1: f } });
    expect(res.ok).toBe(true);
    expect(await teamReads(f)).toBe(true);
  });

  it('a folder share carries its pages and their embeds to team, and back', async () => {
    const t = await import('./tree/write');
    const c = await import('./pages/tree');
    const d = await import('./pages/draft');
    const folder = await t.createTreeFolder(brain, 'pages', { parentId: null, name: 'Shared' });
    const page = await c.createPage(brain, { title: 'In the folder', folderId: folder.id });
    const f = await file('folder-image');
    await d.updatePage(brain, page.id, { doc: fileEmbedDoc(f) });
    expect(await teamReads(page.id)).toBe(false);
    await t.updateTreeFolder(brain, 'pages', folder.id, { share: 'team' }, { confirm: true });
    expect(await teamReads(page.id)).toBe(true);
    expect(await teamReads(f)).toBe(true);
    await t.updateTreeFolder(brain, 'pages', folder.id, { share: null }, { confirm: true });
    expect(await teamReads(page.id)).toBe(false);
    expect(await teamReads(f)).toBe(false);
  });

  it('a new app is made with its rows (the apps insert needs no head of its own)', async () => {
    const ap = await import('./apps');
    const app = await ap.createApp(brain, { title: 'An app' });
    expect((await grants(app.id)).Admin?.home).toBe(true);
  });

  it('logged no miss and left no drift', async () => {
    expect(await misses()).toBe(0);
    const drift = await rows<{ n: number }>(sqlTag`select mantle_bridge_drift()::int as n`);
    expect(drift[0]!.n).toBe(0);
  });

  it('the connector bridge keeps Team’s row with the connector’s level and switch', async () => {
    const onTeam = async (slug: string) =>
      (
        await rows<{ write: boolean }>(sqlTag`select write from workspace_resources
          where workspace_id = ${team} and type = 'connector' and ref_id = ${slug}`)
      )[0] ?? null;
    const onAdmin = async (slug: string) =>
      (
        await rows<{ n: number }>(sqlTag`select count(*)::int as n from workspace_resources
          where workspace_id = ${admin} and type = 'connector' and ref_id = ${slug}`)
      )[0]!.n;
    await m.systemDb
      .execute(sqlTag`insert into tool_groups (owner_id, slug, name, integration, audience)
      values (${brain}, 'conn-x', 'x', '{"mcp":{}}'::jsonb, 'team')`);
    expect(await onTeam('conn-x')).toEqual({ write: true });
    expect(await onAdmin('conn-x')).toBe(1);
    await m.systemDb.execute(sqlTag`update tool_groups set audience = 'admin'
      where owner_id = ${brain} and slug = 'conn-x'`);
    expect(await onTeam('conn-x')).toBeNull();
    await m.systemDb.execute(sqlTag`update tool_groups set audience = 'team', enabled = false
      where owner_id = ${brain} and slug = 'conn-x'`);
    expect(await onTeam('conn-x')).toBeNull();
    await m.systemDb.execute(sqlTag`update tool_groups set enabled = true
      where owner_id = ${brain} and slug = 'conn-x'`);
    expect(await onTeam('conn-x')).toEqual({ write: true });
    // An OpenAPI group (no mcp binding) is on Admin only.
    await m.systemDb
      .execute(sqlTag`insert into tool_groups (owner_id, slug, name, integration, audience)
      values (${brain}, 'api-y', 'y', '{"baseUrl":"https://example.invalid"}'::jsonb, 'team')`);
    expect(await onTeam('api-y')).toBeNull();
    expect(await onAdmin('api-y')).toBe(1);
    await m.systemDb.execute(
      sqlTag`delete from tool_groups where owner_id = ${brain} and slug = 'conn-x'`,
    );
    expect(await onAdmin('conn-x')).toBe(0);
    const drift = await rows<{ n: number }>(sqlTag`select mantle_connector_drift()::int as n`);
    expect(drift[0]!.n).toBe(0);
    // Drift is seen: a Team row written around the bridge.
    await m.systemDb
      .execute(sqlTag`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${team}, 'connector', 'api-y', true)`);
    const after = await rows<{ n: number }>(sqlTag`select mantle_connector_drift()::int as n`);
    expect(after[0]!.n).toBe(1);
  });
});

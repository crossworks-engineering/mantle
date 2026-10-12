/**
 * What draw_get's reader gets of a drawing (draw-reader.ts), on a real,
 * migrated Postgres, the readers in the shim's workspace scope (withViewer
 * with { login }, workspaces W5b2):
 *
 *  - the drawing itself follows the reader's scope: a member reaches the
 *    drawing a workspace of theirs holds and not an admin one, a second
 *    member whose workspace holds only the client items neither;
 *  - the draft flag is only asked where drafts are readable (the workspace
 *    role holds no draft columns, so asking there would fail the whole read);
 *  - the snapshot's inlined images follow the scope's image rule: the owner
 *    keeps all, a member keeps the team file and loses the admin one, the
 *    second member keeps only the client file its workspace holds.
 *
 * There is no client login since W8a, and the draw reader reads in the
 * current scope only since W8d (no member or client reader of its own).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/draw-reader.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sanitizeSceneSvg } from './svg-sanitize';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('draw_get reader rules', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let dr: typeof import('./draw-reader');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `drawread-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-drawread-'));
  // The shared test brain (`mantle_brain_id()`): the level roles only ever
  // see the brain's own rows. Never deleted by a test.
  let anchor = '';
  const member = randomUUID();
  const second = randomUUID();
  // The member's workspace holds the team and client items; the second
  // member's the client ones. Nobody but the owner holds the admin ones.
  const ws = { members: randomUUID(), second: randomUUID() };
  const asMember = <T>(fn: () => Promise<T>) => m.withViewer({ login: member }, fn);
  const asSecond = <T>(fn: () => Promise<T>) => m.withViewer({ login: second }, fn);
  const d = { team: randomUUID(), admin: randomUUID(), client: randomUUID() };
  const f = { team: randomUUID(), admin: randomUUID(), client: randomUUID() };
  const fileRefs = { sceneTeam: f.team, sceneAdmin: f.admin, sceneClient: f.client };
  // A PNG header of a given width: all the sanitizer's pixel budget reads.
  const png = (w: number) => {
    const b = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(1, 20);
    return b.toString('base64');
  };
  const TEAM = png(11);
  const ADMIN = png(12);
  const CLIENT = png(13);
  // exportToSvg's shape: each scene image in a symbol, drawn with <use>.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>' +
    `<symbol id="image-sceneTeam"><image href="data:image/png;base64,${TEAM}"/></symbol>` +
    `<symbol id="image-sceneAdmin"><image href="data:image/png;base64,${ADMIN}"/></symbol>` +
    `<symbol id="image-sceneClient"><image href="data:image/png;base64,${CLIENT}"/></symbol>` +
    '</defs><use href="#image-sceneTeam"/><use href="#image-sceneAdmin"/><use href="#image-sceneClient"/></svg>';
  // What the renderer draws for this reader: the stored snapshot through
  // the parse that applies the reader's image rule.
  const has = (
    s: { snapshot: string; visibleFileIds: ReadonlySet<string> | null } | null,
    b64: string,
  ) =>
    !!s &&
    sanitizeSceneSvg(
      s.snapshot,
      s.visibleFileIds ? { keepImagesOf: s.visibleFileIds } : {},
    ).svg.includes(`base64,${b64}`);
  // Each image file's own extracted text, and the scene_text a commit folds
  // from all of them (what the brain indexed for the owner).
  const words = { team: 'TEAMWORDS', admin: 'ADMINWORDS', client: 'CLIENTWORDS' };
  const scene = { elements: [{ id: 't1', type: 'text', text: 'Ingest', originalText: 'Ingest' }] };
  const storedText =
    'Ingest\n\n[Embedded file: team]\nTEAMWORDS\n\n[Embedded file: admin]\nADMINWORDS\n\n[Embedded file: client]\nCLIENTWORDS';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    dr = await import('./draw-reader');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    anchor = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${member}, ${`${tag}-pat@example.invalid`}, 'x', 'member', 'Pat'),
        (${second}, ${`${tag}-second@example.invalid`}, 'x', 'member', 'Second')`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${ws.members}, ${anchor}, ${`${tag} members`}),
        (${ws.second}, ${anchor}, ${`${tag} second`})`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values
        (${ws.members}, ${member}), (${ws.second}, ${second})`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${f.team}, ${anchor}, 'file', ${`${tag} team file`}, 'files', 'team'),
        (${f.admin}, ${anchor}, 'file', ${`${tag} admin file`}, 'files', 'admin'),
        (${f.client}, ${anchor}, 'file', ${`${tag} client file`}, 'files', 'client'),
        (${d.team}, ${anchor}, 'draw', ${`${tag} team drawing`}, 'draws', 'team'),
        (${d.admin}, ${anchor}, 'draw', ${`${tag} admin drawing`}, 'draws', 'admin'),
        (${d.client}, ${anchor}, 'draw', ${`${tag} client drawing`}, 'draws', 'client')`);
    for (const [k, w] of Object.entries(words)) {
      await m.systemDb.execute(sqlTag`
        update nodes set data = ${JSON.stringify({ text: w })}::jsonb
         where id = ${f[k as keyof typeof f]}`);
    }
    for (const id of [d.team, d.admin, d.client]) {
      await m.systemDb.execute(sqlTag`
        insert into draws (node_id, scene, file_refs, scene_svg, scene_text, draft_scene) values
          (${id}, ${JSON.stringify(scene)}::jsonb, ${JSON.stringify(fileRefs)}::jsonb, ${svg},
           ${storedText}, ${JSON.stringify({ elements: [{ id: 'draft-only' }] })}::jsonb)`);
    }
    const holds: Array<[string, string]> = [
      [ws.members, d.team],
      [ws.members, d.client],
      [ws.members, f.team],
      [ws.members, f.client],
      [ws.second, d.client],
      [ws.second, f.client],
    ];
    for (const [wsId, id] of holds) {
      await m.withSubtreeHeads(id, [], (tx) =>
        tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${wsId})`),
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of [...Object.values(d), ...Object.values(f)]) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await m.systemDb.execute(
      sqlTag`delete from workspaces where id in (${ws.members}, ${ws.second})`,
    );
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${member}, ${second})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${member}, ${second})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('owner: every drawing, the draft flag, and the snapshot with every image', async () => {
    const meta = await dr.readableDraw(anchor, d.admin);
    expect(meta).toMatchObject({ id: d.admin, hasDraft: true, hasSvg: true });
    const out = await dr.readableDrawSvg(anchor, d.admin);
    expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([true, true, true]);
    expect(out?.visibleFileIds).toBeNull();
  });

  it('member: the team drawing without its admin image, never the admin drawing', async () => {
    await asMember(async () => {
      expect(await dr.readableDraw(anchor, d.admin)).toBeNull();
      expect(await dr.readableDrawSvg(anchor, d.admin)).toBeNull();
      // The draft columns are not readable in a workspace scope: the flag says false
      // instead of failing the read.
      expect(await dr.readableDraw(anchor, d.team)).toMatchObject({
        hasDraft: false,
        hasSvg: true,
      });
      const out = await dr.readableDrawSvg(anchor, d.team);
      expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([true, false, true]);
      expect([...(out?.visibleFileIds ?? [])].sort()).toEqual(['sceneClient', 'sceneTeam']);
    });
  });

  it('the second member: only the client drawing, with only the client image', async () => {
    await asSecond(async () => {
      expect(await dr.readableDraw(anchor, d.team)).toBeNull();
      expect(await dr.readableDrawSvg(anchor, d.team)).toBeNull();
      expect(await dr.readableDraw(anchor, d.client)).toMatchObject({ hasDraft: false });
      const out = await dr.readableDrawSvg(anchor, d.client);
      expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([false, false, true]);
    });
  });

  it('the byte routes’ SVG (scopedDrawSvg) keeps the same images as the reader', async () => {
    await asMember(async () => {
      const out = await dr.scopedDrawSvg(anchor, d.team, svg);
      expect([out.includes(TEAM), out.includes(ADMIN), out.includes(CLIENT)]).toEqual([
        true,
        false,
        true,
      ]);
    });
  });

  it('audit M3: the text carries only the words of images the reader may see', async () => {
    // The owner reads the stored text, every image's words in it.
    expect(await dr.readableDrawText(anchor, d.admin)).toBe(storedText);
    await asMember(async () => {
      const text = await dr.readableDrawText(anchor, d.team);
      expect(text).toContain('Ingest');
      expect(text).toContain('TEAMWORDS');
      expect(text).toContain('CLIENTWORDS');
      expect(text).not.toContain('ADMINWORDS');
    });
    await asSecond(async () => {
      const text = await dr.readableDrawText(anchor, d.client);
      expect(text).toContain('CLIENTWORDS');
      expect(text).not.toMatch(/TEAMWORDS|ADMINWORDS/);
    });
  });
});

/**
 * What draw_get's reader gets of a drawing (draw-reader.ts), on a real,
 * migrated Postgres with the level roles:
 *
 *  - the drawing itself follows the reader's scope: a member reaches a team
 *    drawing and not an admin one, a client neither;
 *  - the draft flag is only asked where drafts are readable (the level roles
 *    hold no draft columns, so asking there would fail the whole read);
 *  - the snapshot's inlined images follow each reader's own image rule: the
 *    owner keeps all, a member and a team-level agent keep the team file and
 *    lose the admin one, a client keeps only a client-level file.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/draw-reader.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  const d = { team: randomUUID(), admin: randomUUID(), client: randomUUID() };
  const f = { team: randomUUID(), admin: randomUUID(), client: randomUUID() };
  const fileRefs = { sceneTeam: f.team, sceneAdmin: f.admin, sceneClient: f.client };
  // exportToSvg's shape: each scene image in a symbol, drawn with <use>.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>' +
    '<symbol id="image-sceneTeam"><image href="data:image/png;base64,VEVBTQ=="/></symbol>' +
    '<symbol id="image-sceneAdmin"><image href="data:image/png;base64,QURNSU4="/></symbol>' +
    '<symbol id="image-sceneClient"><image href="data:image/png;base64,Q0xJRU5U"/></symbol>' +
    '</defs><use href="#image-sceneTeam"/><use href="#image-sceneAdmin"/><use href="#image-sceneClient"/></svg>';
  const has = (s: string | null, b64: string) => !!s && s.includes(`base64,${b64}`);
  const TEAM = 'VEVBTQ==';
  const ADMIN = 'QURNSU4=';
  const CLIENT = 'Q0xJRU5U';

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
        (${member}, ${`${tag}-pat@example.invalid`}, 'x', 'member', 'Pat')`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${f.team}, ${anchor}, 'file', ${`${tag} team file`}, 'files', 'team'),
        (${f.admin}, ${anchor}, 'file', ${`${tag} admin file`}, 'files', 'admin'),
        (${f.client}, ${anchor}, 'file', ${`${tag} client file`}, 'files', 'client'),
        (${d.team}, ${anchor}, 'draw', ${`${tag} team drawing`}, 'draws', 'team'),
        (${d.admin}, ${anchor}, 'draw', ${`${tag} admin drawing`}, 'draws', 'admin'),
        (${d.client}, ${anchor}, 'draw', ${`${tag} client drawing`}, 'draws', 'client')`);
    for (const id of [d.team, d.admin, d.client]) {
      await m.systemDb.execute(sqlTag`
        insert into draws (node_id, file_refs, scene_svg, scene_text, draft_scene) values
          (${id}, ${JSON.stringify(fileRefs)}::jsonb, ${svg}, 'Ingest -> Extract',
           ${JSON.stringify({ elements: [{ id: 'draft-only' }] })}::jsonb)`);
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of [...Object.values(d), ...Object.values(f)]) {
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await m.systemDb.execute(sqlTag`delete from spaces where login_id = ${member}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${member}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('owner: every drawing, the draft flag, and the snapshot with every image', async () => {
    const meta = await dr.readableDraw(anchor, d.admin);
    expect(meta).toMatchObject({ id: d.admin, hasDraft: true, hasSvg: true });
    const out = await dr.readableDrawSvg(anchor, d.admin, { kind: 'scope' });
    expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([true, true, true]);
  });

  it('member: the team drawing without its admin image, never the admin drawing', async () => {
    await m.withViewer('team', async () => {
      expect(await dr.readableDraw(anchor, d.admin)).toBeNull();
      expect(
        await dr.readableDrawSvg(anchor, d.admin, { kind: 'member', loginId: member }),
      ).toBeNull();
      // The draft columns are not readable at team: the flag says false
      // instead of failing the read.
      expect(await dr.readableDraw(anchor, d.team)).toMatchObject({
        hasDraft: false,
        hasSvg: true,
      });
      expect(await dr.readableDrawText(anchor, d.team)).toBe('Ingest -> Extract');
      const out = await dr.readableDrawSvg(anchor, d.team, { kind: 'member', loginId: member });
      expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([true, false, true]);
    });
  });

  it('an agent at team level with no login: the files its scope reads', async () => {
    await m.withViewer('team', async () => {
      const out = await dr.readableDrawSvg(anchor, d.team, { kind: 'scope' });
      expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([true, false, true]);
    });
  });

  it('client: only the client drawing, with only the client image', async () => {
    await m.withViewer('client', async () => {
      expect(await dr.readableDraw(anchor, d.team)).toBeNull();
      expect(await dr.readableDrawSvg(anchor, d.team, { kind: 'client' })).toBeNull();
      expect(await dr.readableDraw(anchor, d.client)).toMatchObject({ hasDraft: false });
      const out = await dr.readableDrawSvg(anchor, d.client, { kind: 'client' });
      expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([false, false, true]);
    });
  });

  it('a reader that is not the scope still gets its own rule (fail closed)', async () => {
    // A client reader on an owner path: the client rule, not everything.
    const out = await dr.readableDrawSvg(anchor, d.client, { kind: 'client' });
    expect([has(out, TEAM), has(out, ADMIN), has(out, CLIENT)]).toEqual([false, false, true]);
  });
});

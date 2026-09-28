/**
 * The images a member receives inside a drawing's saved SVG, on a real,
 * migrated Postgres (member logins; audit LOW: a team drawing may inline an
 * admin image). An image stays only when its file passes the member files
 * route's rule: a file at team level or lower in this brain, or one this
 * member wrote and an admin accepted, while the brain file still holds the
 * bytes accepted (audit F07). Never an admin file, another brain's file,
 * another member's accepted file, an accepted file an admin changed, or a
 * ref that is not a file id. The rule is in the query, so the admin pool
 * proves it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-draw-images.viewer.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member drawing images', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let di: typeof import('./member-draw-images');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `mdrawimg-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-drawimg-'));
  // An accepted file's bytes in the brain's files tree, and their sha256
  // (the author's snapshot records it; audit F07).
  const acceptedFile = (name: string, bytes: string) => {
    mkdirSync(path.join(root, 'files'), { recursive: true });
    writeFileSync(path.join(root, 'files', name), bytes);
    return JSON.stringify({
      filename: name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  // Brains of this test's own. Not mantle_brain_id(): test files run in
  // parallel, and another file may create and delete the shared anchor.
  const anchor = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const otherMember = randomUUID();
  const draw = randomUUID();
  const f = {
    team: randomUUID(),
    pub: randomUUID(),
    admin: randomUUID(),
    otherBrain: randomUUID(),
    mineAccepted: randomUUID(),
    theirsAccepted: randomUUID(),
    notAFile: randomUUID(),
  };
  // Scene file id -> file node id, as the editor stores them.
  const fileRefs = {
    sceneTeam: f.team,
    sceneTeamAgain: f.team,
    scenePub: f.pub,
    sceneAdmin: f.admin,
    sceneOtherBrain: f.otherBrain,
    sceneMine: f.mineAccepted,
    sceneTheirs: f.theirsAccepted,
    sceneNotAFile: f.notAFile,
    sceneJunk: 'not-a-uuid',
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    di = await import('./member-draw-images');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin', null),
        (${other}, ${`${tag}-other@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${tag}-pat@example.invalid`}, 'x', 'member', 'Pat'),
        (${otherMember}, ${`${tag}-sam@example.invalid`}, 'x', 'member', 'Sam')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values
        (${anchor}, 'brain', ${anchor}), (${other}, 'brain', ${other})`);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${f.team}, ${anchor}, 'file', ${`${tag} team`}, 'files', 'team'),
        (${f.pub}, ${anchor}, 'file', ${`${tag} public`}, 'files', 'public'),
        (${f.admin}, ${anchor}, 'file', ${`${tag} admin`}, 'files', 'admin'),
        (${f.otherBrain}, ${other}, 'file', ${`${tag} other`}, 'files', 'team'),
        (${f.mineAccepted}, ${anchor}, 'file', ${`${tag} mine`}, 'files', 'admin'),
        (${f.theirsAccepted}, ${anchor}, 'file', ${`${tag} theirs`}, 'files', 'admin'),
        (${f.notAFile}, ${anchor}, 'note', ${`${tag} note`}, 'notes', 'team'),
        (${draw}, ${anchor}, 'draw', ${`${tag} drawing`}, 'draws', 'team')`);
    await m.systemDb.execute(sqlTag`
      update nodes set data = ${acceptedFile(`${tag}-mine.png`, 'MINE')}::jsonb
       where id = ${f.mineAccepted}`);
    await m.systemDb.execute(sqlTag`
      update nodes set data = ${acceptedFile(`${tag}-theirs.png`, 'THEIRS')}::jsonb
       where id = ${f.theirsAccepted}`);
    await m.systemDb.execute(sqlTag`
      insert into space_items (node_id, author_login_id, review_state, accepted_at) values
        (${f.mineAccepted}, ${member}, 'accepted', now()),
        (${f.theirsAccepted}, ${otherMember}, 'accepted', now())`);
    await m.systemDb.execute(sqlTag`
      insert into draws (node_id, file_refs) values (${draw}, ${JSON.stringify(fileRefs)}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${anchor}, ${other})`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${anchor}, ${other})`);
    await m.systemDb.execute(
      sqlTag`delete from spaces where login_id in (${member}, ${otherMember})`,
    );
    await m.systemDb.execute(
      sqlTag`delete from auth.users where id in (${anchor}, ${other}, ${member}, ${otherMember})`,
    );
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('keeps team-level and lower files and the member’s own accepted file, nothing else', async () => {
    const ids = await di.memberVisibleDrawFileIds(anchor, member, draw);
    expect([...ids].sort()).toEqual(['sceneMine', 'scenePub', 'sceneTeam', 'sceneTeamAgain']);
  });

  it('another member does not get this member’s accepted file', async () => {
    const ids = await di.memberVisibleDrawFileIds(anchor, otherMember, draw);
    expect([...ids].sort()).toEqual(['scenePub', 'sceneTeam', 'sceneTeamAgain', 'sceneTheirs']);
  });

  it('an accepted file an admin changed since is taken out (audit F07)', async () => {
    writeFileSync(path.join(root, 'files', `${tag}-mine.png`), 'ADMIN CHANGED');
    try {
      const ids = await di.memberVisibleDrawFileIds(anchor, member, draw);
      expect([...ids].sort()).toEqual(['scenePub', 'sceneTeam', 'sceneTeamAgain']);
      // The author's own drawing as ACCEPTED (its snapshot's refs) keeps it:
      // the bytes inside that SVG are the ones accepted.
      const snap = await di.memberVisibleDrawFileIds(anchor, member, draw, {
        sceneMine: f.mineAccepted,
      });
      expect([...snap]).toEqual(['sceneMine']);
    } finally {
      writeFileSync(path.join(root, 'files', `${tag}-mine.png`), 'MINE');
    }
  });

  it('a drawing with no file refs keeps no images', async () => {
    expect(await di.memberVisibleDrawFileIds(anchor, member, randomUUID())).toEqual(new Set());
  });

  it('sends the SVG with the admin image taken out', async () => {
    const sym = (id: string, bytes: string) =>
      `<symbol id="image-${id}"><image href="data:image/png;base64,${bytes}" width="100%" height="100%"></image></symbol>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${sym('sceneTeam', 'VEVBTQ==')}${sym('sceneAdmin', 'U0VDUkVU')}</defs><use href="#image-sceneTeam"/><use href="#image-sceneAdmin"/></svg>`;
    const out = await di.memberDrawSvg(anchor, member, draw, svg);
    expect(out).toContain('VEVBTQ==');
    expect(out).not.toContain('U0VDUkVU');
    expect(out).toContain('<symbol id="image-sceneAdmin"></symbol>');
  });

  it('reads on the admin pool only', async () => {
    await expect(
      m.withViewer('team', () => di.memberVisibleDrawFileIds(anchor, member, draw)),
    ).rejects.toThrow(/admin pool/);
  });
});

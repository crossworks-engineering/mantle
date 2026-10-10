/**
 * The client files route's `?thumb=1` branch (client logins C2, audit B6) on
 * a real, migrated Postgres, through the real handler and the real client
 * gate (a client `?at=` token over a real client login row). A thumbnail is
 * served only for an image the client's workspace holds (W5b2: a grant on a
 * workspace the client login is a user of): an image only another workspace
 * holds is a 404 even when its thumbnail sits in the cache (the same bytes
 * as the client's image, so the cache would answer at once if the lookup
 * ever ran outside the client's own scope).
 * No image is decoded: both files share one content hash whose thumbnail is
 * put in the cache first.
 *
 * Brain items belong to the shared test anchor (ensureTestAnchor), the two
 * workspaces are this test's own; removes its rows after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run 'server/web/app/api/client/files/[id]/client-thumb.db.test.ts'
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client files route: thumbnails', () => {
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  let tokens: typeof import('@/lib/auth/tokens');
  let runWith: typeof import('@/server/request-context').runWithRequestContext;
  let route: typeof import('./route');
  const tag = `cthumb-${randomUUID().slice(0, 8)}`;
  const clientLogin = randomUUID();
  const clientImage = randomUUID();
  const teamImage = randomUUID();
  // The client's workspace, and one the client is not in (the team's).
  const ws = { client: randomUUID(), team: randomUUID() };
  const sha = createHash('sha256').update(tag).digest('hex');
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-cthumb-'));
  let brain = '';
  let at = '';

  const thumb = async (id: string): Promise<Response> => {
    const req = new Request(`http://x/api/client/files/${id}?thumb=1&at=${at}`);
    return runWith({ req, path: new globalThis.URL(req.url).pathname, method: 'GET' }, () =>
      route.GET(req, { params: Promise.resolve({ id }) }),
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'client-thumb-db-test-secret-at-least-32-chars';
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    tokens = await import('@/lib/auth/tokens');
    runWith = (await import('@/server/request-context')).runWithRequestContext;
    route = await import('./route');
    const { thumbsRoot, THUMB_MAX_DIM } = await import('@mantle/files');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof m.ensureViewerRoles>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${clientLogin}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Client Person')`);
    const data = (name: string) =>
      JSON.stringify({
        filename: `${tag}-${name}.png`,
        mime_type: 'image/png',
        sha256: sha,
        size_bytes: 3,
      });
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${clientImage}, ${brain}, 'file', ${`${tag} client image`}, 'files', ${data('client')}::jsonb),
        (${teamImage}, ${brain}, 'file', ${`${tag} team image`}, 'files', ${data('team')}::jsonb)`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values
        (${ws.client}, ${brain}, ${`${tag} client`}), (${ws.team}, ${brain}, ${`${tag} team`})`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values (${ws.client}, ${clientLogin})`);
    await m.withHeads([clientImage, teamImage], 'update', (tx) =>
      tx.execute(sqlTag`
        insert into item_grants (node_id, workspace_id) values
          (${clientImage}, ${ws.client}), (${teamImage}, ${ws.team})`),
    );
    mkdirSync(thumbsRoot(), { recursive: true });
    writeFileSync(path.join(thumbsRoot(), `${sha}.${THUMB_MAX_DIM}.jpg`), 'CACHEDTHUMB');
    at = tokens.buildAssetToken(brain, clientLogin, 0);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where id in (${clientImage}, ${teamImage})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${clientLogin}`);
    await m.systemDb.execute(sqlTag`delete from workspaces where id in (${ws.client}, ${ws.team})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('serves the thumbnail of an image the client workspace holds', async () => {
    const res = await thumb(clientImage);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('CACHEDTHUMB');
  });

  it('an image only another workspace holds is a 404, though its thumbnail is cached', async () => {
    const res = await thumb(teamImage);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('CACHEDTHUMB');
  });
});

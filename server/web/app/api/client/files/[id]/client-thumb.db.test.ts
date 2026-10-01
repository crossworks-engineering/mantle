/**
 * The client files route's `?thumb=1` branch (client logins C2, audit B6) on
 * a real, migrated Postgres, through the real handler and the real client
 * gate (a client `?at=` token over a real client login row). A thumbnail is
 * served only for a client-level image: a team image is a 404 even when its
 * thumbnail sits in the cache (the same bytes as a client image, so the
 * cache would answer at once if the lookup ever ran above the client level).
 * No image is decoded: both files share one content hash whose thumbnail is
 * put in the cache first.
 *
 * Brain items belong to the shared test anchor (ensureTestAnchor); removes
 * its rows after.
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
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${clientImage}, ${brain}, 'file', ${`${tag} client image`}, 'files', 'client', ${data('client')}::jsonb),
        (${teamImage}, ${brain}, 'file', ${`${tag} team image`}, 'files', 'team', ${data('team')}::jsonb)`);
    mkdirSync(thumbsRoot(), { recursive: true });
    writeFileSync(path.join(thumbsRoot(), `${sha}.${THUMB_MAX_DIM}.jpg`), 'CACHEDTHUMB');
    at = tokens.buildAssetToken(brain, clientLogin, 0);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where id in (${clientImage}, ${teamImage})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${clientLogin}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('serves the thumbnail of a client image', async () => {
    const res = await thumb(clientImage);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('CACHEDTHUMB');
  });

  it('a team image thumbnail is a 404, though its thumbnail is cached', async () => {
    const res = await thumb(teamImage);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('CACHEDTHUMB');
  });
});

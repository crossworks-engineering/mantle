/**
 * New bytes over a file never remove its extracted images (file history,
 * docs/files.md "File history"; images.ts maybeExtractEmbeddedImages), on a
 * migrated scratch database with both checks on, run as the extract queue
 * runs it (the system scope `queue:extract`):
 *
 *  - images of older bytes stay (Pages embed them by id) and are marked
 *    `olderVersion`;
 *  - a new image pass runs only when a person put the new bytes there
 *    (`data.replaced_by` owner or member): an agent's, an export's or the
 *    system's save starts no pass (no vision work);
 *  - bytes put back (a restore) whose images are there: no pass, and those
 *    images lose the mark.
 *
 * The byte load is stubbed and records which files the pass opened.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/images-older-version.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('./file-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bytes')>();
  return {
    ...actual,
    // Opening a file is loading its bytes: record it, and load none, so the
    // pass stops there.
    loadFileBytes: async (node: { id: string }) => {
      h.opened.push(node.id);
      return null;
    },
  };
});
vi.mock('./trace', () => ({ stepInOwnTrace: async () => undefined }));

describe.skipIf(!URL)('extracted images of an older version: kept, marked', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  const owner = randomUUID();
  const tag = `imov${randomUUID().slice(0, 6)}`;
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A pdf file node whose current bytes are `sha`, and one image made from `from`. */
  const fileWithImage = async (sha: string, from: string, extra: Record<string, unknown>) => {
    const id = randomUUID();
    const image = randomUUID();
    const filename = `${tag}-${id.slice(0, 8)}.pdf`;
    const data = { filename, sha256: sha, ...extra };
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${id}, ${owner}, 'file', ${filename}, 'files', ${JSON.stringify(data)}::jsonb)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path, data, tags) values
      (${image}, ${owner}, 'file', ${`${filename} image`}, 'files',
       ${JSON.stringify({ filename: `${image}.png`, sourceFileId: id, sourceSha256: from })}::jsonb,
       array['file', 'extracted-image'])`);
    const node = {
      id,
      ownerId: owner,
      type: 'file',
      title: filename,
      path: 'files',
      loginId: null,
      data,
    } as unknown as typeof import('@mantle/db').nodes.$inferSelect;
    return { node, image };
  };
  const imageData = async (id: string) =>
    (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]
      ?.data;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ({ maybeExtractEmbeddedImages } = await import('./images'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
  }, 240_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    delete process.env.MANTLE_TEST_EDIT_CHECK;
    await m?.closeDb();
    await scratch?.drop();
  });

  beforeEach(() => {
    h.opened.length = 0;
  });

  it("an agent's, an export's or the system's new bytes: the older images stay, marked; no pass", async () => {
    for (const by of ['agent', 'export', 'system']) {
      const { node, image } = await fileWithImage(B, A, {
        replaced_at: new Date().toISOString(),
        replaced_by: by,
      });
      await extract(() => maybeExtractEmbeddedImages(node, owner, 10));
      expect(h.opened, by).toEqual([]);
      expect(await imageData(image), by).toMatchObject({
        sourceFileId: node.id,
        olderVersion: true,
      });
    }
  });

  it("a person's new bytes: the older images stay, marked, and a new pass runs", async () => {
    for (const by of ['owner', 'member']) {
      h.opened.length = 0;
      const { node, image } = await fileWithImage(B, A, {
        replaced_at: new Date().toISOString(),
        replaced_by: by,
      });
      await extract(() => maybeExtractEmbeddedImages(node, owner, 10));
      expect(h.opened, by).toEqual([node.id]);
      expect(await imageData(image), by).toMatchObject({ olderVersion: true });
    }
  });

  it('bytes whose images are there (a restore): no pass, and those images lose the mark', async () => {
    const { node, image } = await fileWithImage(A, A, {
      replaced_at: new Date().toISOString(),
      replaced_by: 'owner',
    });
    await x(
      sql`update nodes set data = data || '{"olderVersion": true}'::jsonb where id = ${image}`,
    );
    await extract(() => maybeExtractEmbeddedImages(node, owner, 10));
    expect(h.opened).toEqual([]);
    expect(await imageData(image)).not.toHaveProperty('olderVersion');
  });

  it('a file never replaced, its images there: nothing changes (as before)', async () => {
    const { node, image } = await fileWithImage(A, A, {});
    await extract(() => maybeExtractEmbeddedImages(node, owner, 10));
    expect(h.opened).toEqual([]);
    expect(await imageData(image)).not.toHaveProperty('olderVersion');
  });
});

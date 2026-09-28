/**
 * The extract-exempt rule's SQL form on a real, migrated Postgres: the boot
 * drain and the missed-event sweep (`unextractedNodeConds`) never re-queue a
 * Forum archive page or a team request no admin has acted on yet, and they
 * do pick the request up once it is reviewed (audit F08).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/extract-exempt.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('unextractedNodeConds', () => {
  let m: typeof import('./index');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `xex-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const id = {
    archive: randomUUID(),
    pending: randomUUID(),
    reviewed: randomUUID(),
    plain: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('./index');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${id.archive}, ${anchor}, 'page', 'Archived topic', 'pages',
        '{"source":"forum-archive"}'::jsonb),
      (${id.pending}, ${anchor}, 'task', 'Member request', 'tasks',
        '{"source":"team-request","status":"open"}'::jsonb),
      (${id.reviewed}, ${anchor}, 'task', 'Reviewed request', 'tasks',
        '{"source":"team-request","status":"open","reviewed_at":"2026-09-28T10:00:00.000Z"}'::jsonb),
      (${id.plain}, ${anchor}, 'task', 'Plain task', 'tasks', '{"status":"open"}'::jsonb)`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
  });

  it('re-queues the reviewed request and the plain task, never the exempt two', async () => {
    const rows = await m.systemDb
      .select({ id: m.nodes.id })
      .from(m.nodes)
      .where(m.unextractedNodeConds(anchor, new Date(Date.now() - 60_000)));
    const got = new Set(rows.map((r) => r.id));
    expect(got.has(id.reviewed)).toBe(true);
    expect(got.has(id.plain)).toBe(true);
    expect(got.has(id.archive)).toBe(false);
    expect(got.has(id.pending)).toBe(false);
  });
});

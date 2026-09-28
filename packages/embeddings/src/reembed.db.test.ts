/**
 * A repopulating re-embed (`--repopulate`, or the rebuild action with
 * `repopulate: true`) on a real, migrated Postgres: it walks every node with
 * no vector, but never the extract-exempt ones (a Forum archive page, a team
 * request no admin has acted on), which are never indexed (audit F27). A dry
 * run counts the rows it would embed and writes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/embeddings/src/reembed.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('runReembed repopulate skips extract-exempt nodes', () => {
  let m: typeof import('@mantle/db');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `rmb-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into nodes (owner_id, type, title, path, data) values
      (${anchor}, 'page', 'Archived private topic', 'pages', '{"source":"forum-archive"}'::jsonb),
      (${anchor}, 'task', 'Member request', 'tasks', '{"source":"team-request"}'::jsonb),
      (${anchor}, 'task', 'Reviewed request', 'tasks',
        '{"source":"team-request","reviewed_at":"2026-09-28T10:00:00.000Z"}'::jsonb),
      (${anchor}, 'note', 'Plain note', 'notes', '{}'::jsonb)`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
  });

  it('counts the plain note and the reviewed request, not the exempt two', async () => {
    const { runReembed } = await import('./reembed');
    const res = await runReembed(anchor, {
      model: 'test/embedding-model',
      tables: ['nodes'],
      includeUnembedded: true,
      dryRun: true,
    });
    expect(res.byTable.nodes.rows).toBe(2);
    expect(res.byTable.nodes.written).toBe(0);
  });
});

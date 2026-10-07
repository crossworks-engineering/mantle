/**
 * The extractor's safety nets on a real, migrated Postgres, for a node that
 * was extracted once and then CHANGED while the agent was not listening (the
 * docs sync at web boot during a roll; dev, 2026-10-05: 365 documentation
 * nodes with no summary and no embedding):
 *
 *  - the boot drain (`unextractedNodeConds`) windows on `updated_at`, so an
 *    old node written recently is picked up, and an old node left alone is not;
 *  - the sweep's extra clause (`noExtractSinceWriteSql`) picks a node whose
 *    last run finished before its last write, and leaves one whose last run
 *    finished after it (loop safety: a processed version never re-queues).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/extract-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { and } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('extract safety nets after a content change', () => {
  let m: typeof import('./index');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `xsw-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const id = {
    resynced: randomUUID(), // created 60 days ago, run 30 days ago, synced a minute ago
    current: randomUUID(), // created 60 days ago, synced a minute ago, run after that
    untouched: randomUUID(), // created and last written 60 days ago, never run
    fresh: randomUUID(), // created a minute ago, never run
  };
  const since = () => new Date(Date.now() - 7 * 24 * 3_600_000);

  const drained = async () => {
    const rows = await m.systemDb
      .select({ id: m.nodes.id })
      .from(m.nodes)
      .where(m.unextractedNodeConds(anchor, since()));
    return new Set(rows.map((r) => r.id));
  };
  const swept = async () => {
    const rows = await m.systemDb
      .select({ id: m.nodes.id })
      .from(m.nodes)
      .where(and(m.unextractedNodeConds(anchor, since()), m.noExtractSinceWriteSql()));
    return new Set(rows.map((r) => r.id));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('./index');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict do nothing`;
    await admin`insert into nodes (id, owner_id, type, title, path, data, created_at, updated_at) values
      (${id.resynced}, ${anchor}, 'documentation', 'guide/a.md', 'docs', '{"brain_depth":"retrieval"}'::jsonb,
        now() - interval '60 days', now() - interval '1 minute'),
      (${id.current}, ${anchor}, 'documentation', 'guide/b.md', 'docs', '{"brain_depth":"retrieval"}'::jsonb,
        now() - interval '60 days', now() - interval '1 minute'),
      (${id.untouched}, ${anchor}, 'documentation', 'guide/c.md', 'docs', '{"brain_depth":"retrieval"}'::jsonb,
        now() - interval '60 days', now() - interval '60 days'),
      (${id.fresh}, ${anchor}, 'note', 'New note', 'notes', '{}'::jsonb,
        now() - interval '1 minute', now() - interval '1 minute')`;
    await admin`insert into traces (owner_id, kind, subject_id, subject_kind, status, started_at, finished_at, created_at) values
      (${anchor}, 'extractor_run', ${id.resynced}, 'node', 'success',
        now() - interval '30 days', now() - interval '30 days', now() - interval '30 days'),
      (${anchor}, 'extractor_run', ${id.current}, 'node', 'skipped', now(), now(), now())`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
  });

  it('the drain windows on the last write, not on creation', async () => {
    const got = await drained();
    expect(got.has(id.resynced)).toBe(true);
    expect(got.has(id.current)).toBe(true);
    expect(got.has(id.fresh)).toBe(true);
    expect(got.has(id.untouched)).toBe(false);
  });

  it('the sweep re-queues a changed node whose last run is older than the change', async () => {
    const got = await swept();
    expect(got.has(id.resynced)).toBe(true);
    expect(got.has(id.fresh)).toBe(true);
  });

  it('the sweep leaves a node whose current version was already processed', async () => {
    const got = await swept();
    expect(got.has(id.current)).toBe(false);
    expect(got.has(id.untouched)).toBe(false);
  });
});

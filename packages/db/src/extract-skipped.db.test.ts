/**
 * Terminal skips on a real, migrated Postgres (extract-exempt.ts,
 * `data.extract_skipped`):
 *
 *  - the boot drain (`unextractedNodeConds`, which the provider recovery
 *    drain and the missed-event sweep share) leaves a stamped node alone,
 *    and picks it up again once the node is written after the stamp;
 *  - a short committed page with no stamp IS queued (the drain has no
 *    minimum length: a page under the extractor's minimum is stamped by the
 *    extractor, never dropped by the query);
 *  - the cleanup (`backfillTerminalSkips`) stamps a node whose last run was a
 *    content verdict once, and never one whose last run was a machinery
 *    failure; a second run finds nothing.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/extract-skipped.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('terminal extract skips', () => {
  let m: typeof import('./index');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `xsk-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const id = {
    exe: randomUUID(), // last run no_parser: the NATREF loop
    shortPage: randomUUID(), // a 57-char committed page, never run
    unreadable: randomUUID(), // last run pdf_unreadable: machinery, retry
    edited: randomUUID(), // no_parser, then written after the run
  };

  const drained = async () => {
    const rows = await m.systemDb
      .select({ id: m.nodes.id })
      .from(m.nodes)
      .where(m.unextractedNodeConds(anchor, new Date(Date.now() - 3_600_000)));
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
    // Created and last written a minute ago; the runs below are after that.
    await admin`insert into nodes (id, owner_id, type, title, path, data, created_at, updated_at) values
      (${id.exe}, ${anchor}, 'file', 'setup-tool-installer-v2.exe', 'files', '{}'::jsonb,
        now() - interval '1 minute', now() - interval '1 minute'),
      (${id.shortPage}, ${anchor}, 'page', 'Note to self', 'pages', '{}'::jsonb,
        now() - interval '1 minute', now() - interval '1 minute'),
      (${id.unreadable}, ${anchor}, 'file', 'drawing.pdf', 'files', '{}'::jsonb,
        now() - interval '1 minute', now() - interval '1 minute'),
      (${id.edited}, ${anchor}, 'file', 'old.exe', 'files', '{}'::jsonb,
        now() - interval '1 minute', now() + interval '1 minute')`;
    await admin`insert into traces (owner_id, kind, subject_id, subject_kind, status, started_at, data) values
      (${anchor}, 'extractor_run', ${id.exe}, 'node', 'skipped', now(), '{"disposition":"no_parser"}'::jsonb),
      (${anchor}, 'extractor_run', ${id.unreadable}, 'node', 'skipped', now(), '{"disposition":"pdf_unreadable"}'::jsonb),
      (${anchor}, 'extractor_run', ${id.edited}, 'node', 'skipped', now(), '{"disposition":"no_parser"}'::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
  });

  it('queues all four before any stamp, the short page included', async () => {
    const got = await drained();
    for (const n of Object.values(id)) expect(got.has(n)).toBe(true);
  });

  it('stamps the content verdict once, never the machinery failure or the edited node', async () => {
    const stamped = async () => {
      const rows = await admin`select id from nodes
        where owner_id = ${anchor} and data ? 'extract_skipped'`;
      return rows.map((r) => r.id);
    };
    const dry = await m.backfillTerminalSkips({ dryRun: true });
    expect(dry.stamped).toBeGreaterThanOrEqual(1);
    expect(await stamped()).toEqual([]); // a dry run writes nothing

    await m.backfillTerminalSkips({ dryRun: false });
    expect(await stamped()).toEqual([id.exe]);
    const [row] = await admin`select data from nodes where id = ${id.exe}`;
    expect((row!.data as Row).extract_skipped).toMatchObject({ reason: 'no_parser' });

    // Idempotent: the stamped node is no longer a candidate.
    const again = await m.backfillTerminalSkips({ dryRun: true });
    expect(again.sampleIds).not.toContain(id.exe);
    expect(again.stamped).toBe(dry.stamped - 1);
  });

  it('the drain leaves the stamped node alone and still queues the rest', async () => {
    const got = await drained();
    expect(got.has(id.exe)).toBe(false);
    expect(got.has(id.shortPage)).toBe(true);
    expect(got.has(id.unreadable)).toBe(true);
    expect(got.has(id.edited)).toBe(true);
  });

  it('a write after the stamp makes it stale: the drain queues the node again', async () => {
    await admin`update nodes set updated_at = now() + interval '1 second' where id = ${id.exe}`;
    expect((await drained()).has(id.exe)).toBe(true);
  });

  it('the stamp the extractor writes holds the same way', async () => {
    await m.systemDb
      .update(m.nodes)
      .set({ data: sql`${m.nodes.data} || ${m.extractSkippedStamp('body_too_short')}` })
      .where(eq(m.nodes.id, id.shortPage));
    expect((await drained()).has(id.shortPage)).toBe(false);
  });
});

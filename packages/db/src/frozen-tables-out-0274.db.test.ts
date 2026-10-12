/**
 * 0274 (workspaces W8d): the frozen chat and client tables go, on scratch
 * databases migrated to just before 0274.
 *
 *  - team_messages is dropped only when every row is kept elsewhere (a
 *    login's row in assistant_messages, a contact's in archive_team_messages,
 *    0269); a row in neither (a login's row whose copy went when its Team
 *    assistant was deleted with its conversation) is archived first, as it
 *    was, then the table goes (W8 integration);
 *  - team_read_cursors, team_notifications, login_chat_read_cursors,
 *    client_report_acks and client_quota_refusals are archived row for row,
 *    then dropped, with the two trigger functions left behind;
 *  - the spaces family stays (W10);
 *  - a second run changes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/frozen-tables-out-0274.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0274_workspaces_frozen_tables_out';

const DROPPED = [
  'team_messages',
  'team_read_cursors',
  'team_notifications',
  'login_chat_read_cursors',
  'client_report_acks',
  'client_quota_refusals',
];

/** Run 0274 on `sql`, in one transaction, as migrate.ts does. */
async function run0274(sql: postgres.Sql): Promise<void> {
  const file = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
    'utf8',
  );
  const statements = file
    .split('--> statement-breakpoint')
    .map((x) => x.trim())
    .filter(Boolean);
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt);
  });
}

/** The tables of `names` that exist. */
async function present(sql: postgres.Sql, names: string[]): Promise<string[]> {
  const rows = await sql<{ t: string }[]>`
    select t from unnest(${names}::text[]) as t where to_regclass('public.' || t) is not null`;
  return rows.map((r) => r.t).sort();
}

/** Seed one row in each frozen table; `orphan` adds a login's team_messages
 *  row kept nowhere else: its copy in assistant_messages went when its Team
 *  assistant was deleted with its conversation (`?conversation=delete`). */
async function seed(sql: postgres.Sql, opts: { orphan: boolean }) {
  const owner = randomUUID();
  const member = randomUUID();
  const contact = randomUUID();
  const kept = randomUUID();
  const orphan = randomUUID();
  const ackItem = randomUUID();
  await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
    (${owner}, ${`ft-o-${owner.slice(0, 6)}@example.invalid`}, 'x', 'admin', true),
    (${member}, ${`ft-m-${member.slice(0, 6)}@example.invalid`}, 'x', 'member', false)`;
  await sql`insert into nodes (id, owner_id, type, title, path)
    values (${contact}, ${owner}, 'contact', 'Pat', 'contacts')`;
  // team_messages is frozen (0269): the seed lifts its trigger for the insert.
  await sql.begin(async (tx) => {
    await tx`alter table team_messages disable trigger team_messages_frozen_trg`;
    await tx`insert into team_messages (id, owner_id, contact_id, direction, text, channel, status)
      values (${kept}, ${owner}, ${contact}, 'inbound', 'portal hello', 'web', 'complete')`;
    if (opts.orphan) {
      await tx`insert into team_messages
          (id, owner_id, direction, text, channel, status, login_id, created_at)
        values (${orphan}, ${owner}, 'outbound', 'lost', 'web', 'complete', ${member},
                '2026-01-04T03:04:05Z')`;
    }
    await tx`alter table team_messages enable trigger team_messages_frozen_trg`;
  });
  await sql`insert into archive_team_messages
      (id, owner_id, contact_id, direction, text, channel, status, created_at)
    values (${kept}, ${owner}, ${contact}, 'inbound', 'portal hello', 'web', 'complete', now())`;
  await sql`insert into team_read_cursors (owner_id, contact_id, last_read_at)
    values (${owner}, ${contact}, '2026-01-02T03:04:05Z')`;
  await sql`insert into team_notifications (owner_id, thread_id, recipient_id, sender_id, body)
    values (${owner}, ${randomUUID()}, ${contact}, ${owner}, 'check this')`;
  await sql`insert into login_chat_read_cursors (login_id, last_read_at)
    values (${member}, '2026-01-03T03:04:05Z')`;
  await sql`insert into client_report_acks (owner_id, acked_by, item_ids)
    values (${owner}, ${owner}, ${[ackItem]}::uuid[])`;
  await sql`insert into client_quota_refusals (login_id, reason) values (${member}, 'space-full')`;
  return { owner, member, contact, kept, orphan };
}

describe.skipIf(!URL)('0274: the frozen tables, archived and dropped', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  let before: Record<string, readonly unknown[]>;

  const archives = async () => ({
    cursors: await sql`select owner_id::text, contact_id::text, last_read_at
                         from archive_team_read_cursors order by 1, 2`,
    notifications: await sql`select id::text, owner_id::text, recipient_id::text, sender_id::text,
                                    body, created_at
                               from archive_team_notifications order by 1`,
    loginCursors: await sql`select login_id::text, last_read_at
                              from archive_login_chat_read_cursors order by 1`,
    acks: await sql`select id::text, owner_id::text, acked_by::text, acked_at,
                           item_ids::text[] as item_ids
                      from archive_client_report_acks order by 1`,
    refusals: await sql`select id::text, login_id::text, reason, created_at
                          from archive_client_quota_refusals order by 1`,
  });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await seed(sql, { orphan: false });
    before = {
      cursors: await sql`select owner_id::text, contact_id::text, last_read_at
                           from team_read_cursors order by 1, 2`,
      notifications: await sql`select id::text, owner_id::text, recipient_id::text,
                                      sender_id::text, body, created_at
                                 from team_notifications order by 1`,
      loginCursors: await sql`select login_id::text, last_read_at
                                from login_chat_read_cursors order by 1`,
      acks: await sql`select id::text, owner_id::text, acked_by::text, acked_at,
                             item_ids::text[] as item_ids
                        from client_report_acks order by 1`,
      refusals: await sql`select id::text, login_id::text, reason, created_at
                            from client_quota_refusals order by 1`,
    };
    await run0274(sql);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('archives every row of each table as it was, then drops the tables', async () => {
    expect(await archives()).toEqual(before);
    for (const rows of Object.values(before)) expect(rows).toHaveLength(1);
    expect(await present(sql, DROPPED)).toEqual([]);
  });

  it('drops the trigger functions left behind, and keeps the spaces family', async () => {
    const fns = await sql<{ f: string }[]>`
      select proname as f from pg_proc
       where proname in ('mantle_team_messages_frozen_trg', 'notify_team_notification')`;
    expect(fns).toEqual([]);
    expect(
      await present(sql, [
        'spaces',
        'space_items',
        'space_submissions',
        'space_item_bundles',
        'space_uploads',
        'accepted_snapshots',
        'archive_team_messages',
      ]),
    ).toEqual(
      [
        'accepted_snapshots',
        'archive_team_messages',
        'space_item_bundles',
        'space_items',
        'space_submissions',
        'space_uploads',
        'spaces',
      ].sort(),
    );
  });

  it('the archives are read by the admin pool only', async () => {
    const grants = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where table_schema = 'public' and grantee <> current_user
         and table_name in ('archive_team_read_cursors', 'archive_team_notifications',
                            'archive_login_chat_read_cursors', 'archive_client_report_acks',
                            'archive_client_quota_refusals')`;
    expect(grants[0]!.n).toBe(0);
  });

  it('a second run changes nothing', async () => {
    const again = await archives();
    await run0274(sql);
    expect(await archives()).toEqual(again);
  }, 120_000);
});

describe.skipIf(!URL)('0274: a team_messages row kept nowhere else', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  let ids: Awaited<ReturnType<typeof seed>>;

  const archived = () =>
    sql<{ id: string; login: string | null; text: string; created: string }[]>`
      select id::text, login_id::text as login, text, created_at::text as created
        from archive_team_messages order by text`;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    ids = await seed(sql, { orphan: true });
    await run0274(sql);
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('W8 integration: archives the row as it was, then drops the tables', async () => {
    const rows = await archived();
    expect(rows.map((r) => [r.id, r.login, r.text])).toEqual([
      [ids.orphan, ids.member, 'lost'],
      [ids.kept, null, 'portal hello'],
    ]);
    expect(new Date(rows[0]!.created).toISOString()).toBe('2026-01-04T03:04:05.000Z');
    expect(await present(sql, DROPPED)).toEqual([]);
  });

  it('a second run changes nothing', async () => {
    const again = await archived();
    await run0274(sql);
    expect(await archived()).toEqual(again);
  }, 120_000);
});

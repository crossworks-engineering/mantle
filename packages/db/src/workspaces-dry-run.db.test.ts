/**
 * The workspaces migration dry run and reach diff (migration 0243, plan
 * sections 9.4 and 21.9), on a scratch database of its own: a small brain
 * with an admin, two members, items at every level today, folder shares,
 * embeds, a team app, and personal items in every review state. The dry run
 * must give no login anything it does not read today, list exactly the
 * expected assistant gains, and stop when a client login exists.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-dry-run.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = { section: string; subject: string; metric: string; n: string };

describe.skipIf(!URL)('workspaces dry run and reach diff (0243)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const gone = randomUUID();

  const run = async () =>
    (await sql<Row[]>`select * from mantle_ws_dry_run()`).map((r) => ({ ...r, n: Number(r.n) }));
  const pick = (
    rows: Awaited<ReturnType<typeof run>>,
    section: string,
    subject?: string,
    metric?: string,
  ) =>
    rows.filter(
      (r) =>
        r.section === section &&
        (subject === undefined || r.subject === subject) &&
        (metric === undefined || r.metric === metric),
    );

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${memberA}, 'a@example.invalid', 'x', 'member', false),
      (${memberB}, 'b@example.invalid', 'x', 'member', false),
      (${gone}, 'g@example.invalid', 'x', 'member', false)`;
    const space = async (login: string) =>
      (
        await sql<
          { id: string }[]
        >`select id from spaces where kind = 'personal' and login_id = ${login}`
      )[0]!.id;
    const spA = await space(memberA);
    const spGone = await space(gone);

    const node = async (owner_: string, type: string, path: string, audience = 'admin') => {
      const id = randomUUID();
      await sql`insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${owner_}, ${type}::node_type, ${type}, ${path}::ltree, ${audience})`;
      return id;
    };
    // Brain items at each level, a shared folder, an embed, apps.
    await node(owner, 'page', 'pages', 'admin');
    await node(owner, 'page', 'pages', 'team');
    await node(owner, 'note', 'notes', 'public');
    await node(owner, 'email', 'emails', 'admin');
    const folder = await node(owner, 'branch', 'pages.shared', 'admin');
    await sql`update nodes set share_level = 'team' where id = ${folder}`;
    await node(owner, 'page', 'pages.shared', 'admin'); // team through the folder
    // The host passes its FOLDER's share to what it embeds (0208: inherited
    // or embedded level, never its own audience): it sits in the shared folder.
    const host = await node(owner, 'page', 'pages.shared', 'admin');
    const embedded = await node(owner, 'file', 'files', 'admin');
    const appViaEmbed = await node(owner, 'app', 'apps', 'admin');
    await sql`insert into node_embeds (from_id, to_id) values (${host}, ${embedded}), (${host}, ${appViaEmbed})`;
    const teamApp = await node(owner, 'app', 'apps', 'team');
    await sql`insert into apps (node_id, source) values (${teamApp}, '{}'::jsonb), (${appViaEmbed}, '{}'::jsonb)`.catch(
      () => {},
    );
    // Personal items in each review state.
    const draftShared = await node(spA, 'page', 'pages');
    const submitted = await node(spA, 'note', 'notes');
    const privateDraft = await node(spA, 'note', 'notes');
    const leftBehind = await node(spGone, 'page', 'pages');
    await sql`insert into space_items (node_id, author_login_id, sharing, review_state) values
      (${draftShared}, ${memberA}, 'team', 'draft'),
      (${submitted}, ${memberA}, 'private', 'submitted'),
      (${privateDraft}, ${memberA}, 'private', 'draft'),
      (${leftBehind}, ${gone}, 'team', 'draft')`;
    await sql`update auth.users set disabled_at = now() where id = ${gone}`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('gives no login anything it does not read today, and every item one home', async () => {
    const rows = await run();
    expect(pick(rows, 'stop')).toEqual([]);
    expect(pick(rows, 'reach-fail')).toEqual([]);
    expect(pick(rows, 'plan-fail')).toEqual([]);
    // The admins lose nothing: every brain item is in Admin or Team.
    expect(pick(rows, 'reach', 'login (admin)', 'lost items (narrower, allowed)')).toEqual([]);
  });

  it('lists exactly the expected assistant gains', async () => {
    const rows = await run();
    const gains = pick(rows, 'reach-expected');
    expect(gains.map((r) => `${r.subject} ${r.metric}`).sort()).toEqual(
      [
        'assistant:admin gained: left-behind items',
        'assistant:admin gained: submitted items',
        'assistant:team gained: team-shared drafts',
      ].sort(),
    );
    expect(gains.every((r) => !r.metric.includes('OTHER'))).toBe(true);
  });

  it('never grants an app through an embed (old trap 2), and homes the team app in Team', async () => {
    const rows = await run();
    expect(pick(rows, 'plan', 'embedded-only apps losing team read (old trap 2)')[0]?.n).toBe(1);
    expect(pick(rows, 'plan', 'apps homed in Team (T1)')[0]?.n).toBe(1);
  });

  it('stops when a client login exists', async () => {
    const client = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${client}, 'c@example.invalid', 'x', 'client')`;
    try {
      const rows = await run();
      expect(pick(rows, 'stop', 'client logins')[0]?.n).toBe(1);
    } finally {
      await sql`delete from auth.users where id = ${client}`;
    }
  });
});

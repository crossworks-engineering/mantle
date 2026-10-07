/**
 * The access shadow report on a real, migrated Postgres (member logins
 * Phase 0b): what a team-level responder would lose, read from recorded team
 * turns. Read-only code; the test seeds a brain of its own (an owner, its
 * team-responder with one admin and one team group, items at both levels,
 * one recorded team turn and one owner turn, two facts) so it runs on the
 * shared test database (CI), and removes it after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/access-shadow.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('access shadow report', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  // A brain of this test's own: the report is owner-scoped, so it needs no
  // anchor, and the slug 'team-responder' is free under a fresh owner.
  const owner = randomUUID();
  const tag = `shadow-${owner.slice(0, 8)}`;
  const ids = {
    adminPage: randomUUID(), // in a team turn's retrieval snapshot
    teamPage: randomUUID(), // in the same snapshot, but already team
    adminNote: randomUUID(), // asked for by a team turn's tool call
    ownerOnly: randomUUID(), // used only by an owner (web) turn
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.adminPage}, ${owner}, 'page', ${`${tag} admin page`}, 'pages', 'admin'),
      (${ids.teamPage}, ${owner}, 'page', ${`${tag} team page`}, 'pages', 'team'),
      (${ids.adminNote}, ${owner}, 'note', ${`${tag} admin note`}, 'notes', 'admin'),
      (${ids.ownerOnly}, ${owner}, 'note', ${`${tag} owner note`}, 'notes', 'admin')`;
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience) values
      (${owner}, 'email-read', 'Email', ${['email_list']}, 'admin'),
      (${owner}, 'team-read', 'Team read', ${['search_nodes']}, 'team')`;
    await admin`insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${owner}, 'team-responder', 'Team', 'fake/model', 'x',
              ${['email-read', 'team-read']})`;

    const snapshot = JSON.stringify({
      snapshot: {
        contentHits: { sent: [{ nodeId: ids.adminPage }, { nodeId: ids.teamPage }] },
        chunkHits: { sent: [{ nodeId: ids.adminPage }] },
      },
    });
    const [team] = await admin<{ id: string }[]>`
      insert into traces (owner_id, kind, data)
      values (${owner}, 'responder_turn', ${JSON.stringify({ surface: 'team' })}::jsonb)
      returning id`;
    await admin`insert into trace_steps (trace_id, ordinal, name, kind, input, output) values
      (${team!.id}, 0, 'load_context', 'compute', '{}'::jsonb, ${snapshot}::jsonb),
      (${team!.id}, 1, 'tool: node_read', 'compute',
       ${JSON.stringify({ node_id: ids.adminNote })}::jsonb, '{}'::jsonb)`;
    const [web] = await admin<{ id: string }[]>`
      insert into traces (owner_id, kind, data)
      values (${owner}, 'responder_turn', ${JSON.stringify({ surface: 'web' })}::jsonb)
      returning id`;
    await admin`insert into trace_steps (trace_id, ordinal, name, kind, input, output) values
      (${web!.id}, 0, 'tool: node_read', 'compute',
       ${JSON.stringify({ node_id: ids.ownerOnly })}::jsonb, '{}'::jsonb)`;

    await admin`insert into facts (owner_id, content, kind, source_node_id) values
      (${owner}, 'from the team page', 'factual', ${ids.teamPage}),
      (${owner}, 'from the owner''s chats', 'factual', null)`;
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin`delete from facts where owner_id = ${owner}`;
      await admin`delete from traces where owner_id = ${owner}`;
      await admin`delete from agents where owner_id = ${owner}`;
      await admin`delete from tool_groups where owner_id = ${owner}`;
      await admin`delete from nodes where owner_id = ${owner}`;
      await admin`delete from spaces where login_id = ${owner}`;
      await admin`delete from auth.users where id = ${owner}`;
    }
    await m?.closeDb();
  });

  it('lists the admin items team turns used, the responder and the usable facts', async () => {
    const { accessShadowReport } = await import('./access-shadow');
    const report = await accessShadowReport(owner, { days: 30 });
    expect(report.turns).toBe(1); // the owner's web turn is not a team turn
    expect(
      report.usedAtAdmin
        .map((i) => [i.id, i.uses])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [ids.adminPage, 2], // a content hit and a passage
        [ids.adminNote, 1], // a tool call
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(report.agent).toEqual({
      slug: 'team-responder',
      audience: 'admin',
      groupsAboveTeam: ['email-read'],
    });
    expect(report.facts).toEqual({ current: 2, withVisibleSource: 1 });
    expect(report.sharedAtCeiling).toEqual([]);
    expect(report.closureGaps).toEqual([]);
  });
});

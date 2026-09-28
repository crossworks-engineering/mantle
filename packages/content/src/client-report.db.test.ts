/**
 * "What clients see" (client logins C1) on a real, migrated Postgres: the
 * report lists every item at client level and nothing else, with its old
 * live link, the addresses a page was emailed to, and the team and admin
 * items it names (mention chips and links, plan N6); the acknowledgement
 * records only what was shown and still is client, and the report asks
 * again once an item not in it goes to client. Seeds a brain of its own
 * (the report reads by owner id, on the admin pool) and removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-report.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the "What clients see" report', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let r: typeof import('./client-report');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const admin = randomUUID();
  const tag = `creport-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(), // client, names a team note, an admin page and a client note
    note: randomUUID(), // client, links a team note in its markdown
    linked: randomUUID(), // client, an old live link
    teamNote: randomUUID(),
    adminPage: randomUUID(),
    clientNote: randomUUID(),
    later: randomUUID(), // team now, client later
  };
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    r = await import('./client-report');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, display_name) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', null),
        (${admin}, ${`${tag}-a@example.invalid`}, 'x', 'Ada Admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: id.teamNote, ref: 'node' } },
            { type: 'mention', attrs: { id: id.clientNote, ref: 'node' } },
            {
              type: 'text',
              text: 'the plan',
              marks: [{ type: 'link', attrs: { href: `/n/${id.adminPage}` } }],
            },
          ],
        },
      ],
    };
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${id.page}, ${owner}, 'page', 'Client page', 'pages', 'client', '{}'::jsonb),
        (${id.note}, ${owner}, 'note', 'Client note one', 'notes', 'client',
         ${JSON.stringify({ content: `see [it](/n/${id.teamNote})` })}::jsonb),
        (${id.linked}, ${owner}, 'page', 'Linked page', 'pages', 'client', '{}'::jsonb),
        (${id.teamNote}, ${owner}, 'note', 'Team secret', 'notes', 'team', '{}'::jsonb),
        (${id.adminPage}, ${owner}, 'page', 'Admin plan', 'pages', 'admin', '{}'::jsonb),
        (${id.clientNote}, ${owner}, 'note', 'Client note two', 'notes', 'client', '{}'::jsonb),
        (${id.later}, ${owner}, 'note', 'Later', 'notes', 'team', '{}'::jsonb)`);
    await exec(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${id.page}, ${JSON.stringify(doc)}::jsonb, ''),
        (${id.linked}, '{"type":"doc","content":[]}'::jsonb, '')`);
    await exec(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, view_count)
      values (${owner}, ${id.linked}, 'page', ${`${tag}-tok`}, 3)`);
    const [t] = (await exec(sqlTag`
      insert into traces (owner_id, kind) values (${owner}, 'responder_turn') returning id`)) as unknown as {
      id: string;
    }[];
    await exec(sqlTag`
      insert into trace_steps (trace_id, ordinal, name, kind, input) values
        (${t!.id}, 0, 'tool: email_page', 'send', ${JSON.stringify({
          slug: 'email_page',
          args: {
            pageId: id.page,
            to: 'Ann@Example.invalid, bob@example.invalid',
            cc: 'cy@example.invalid',
          },
        })}::jsonb)`);
  });

  afterAll(async () => {
    await exec(sqlTag`delete from client_report_acks where owner_id = ${owner}`);
    await exec(sqlTag`delete from traces where owner_id = ${owner}`);
    await exec(sqlTag`delete from shares where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from spaces where id = ${owner} or login_id in (${owner}, ${admin})`);
    await exec(sqlTag`delete from auth.users where id in (${owner}, ${admin})`);
    await m.closeDb();
  });

  it('lists every client item and nothing else, with links, email hints and refs above', async () => {
    const rep = await r.clientReport(owner);
    expect(rep.total).toBe(4);
    expect(rep.items.map((i) => i.id).sort()).toEqual(
      [id.page, id.note, id.linked, id.clientNote].sort(),
    );
    const page = rep.items.find((i) => i.id === id.page)!;
    expect(page.emailedTo).toEqual([
      'ann@example.invalid',
      'bob@example.invalid',
      'cy@example.invalid',
    ]);
    expect(page.link).toBeNull();
    // The team note and the admin page it names; the client note is fine.
    expect(page.refsAbove.map((x) => [x.id, x.audience]).sort()).toEqual(
      [
        [id.adminPage, 'admin'],
        [id.teamNote, 'team'],
      ].sort(),
    );
    expect(rep.items.find((i) => i.id === id.note)!.refsAbove).toEqual([
      { id: id.teamNote, type: 'note', title: 'Team secret', audience: 'team' },
    ]);
    const linked = rep.items.find((i) => i.id === id.linked)!;
    expect(linked.link).toMatchObject({ viewCount: 3, lastViewedAt: null });
    expect(rep.acknowledgement).toBeNull();
    expect(rep.acknowledged).toBe(false);
    expect(rep.newSinceAck.sort()).toEqual([id.page, id.note, id.linked, id.clientNote].sort());
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
  });

  it('an acknowledgement records only what was shown and is client now', async () => {
    const part = await r.acknowledgeClientReport(owner, admin, [id.page, id.note]);
    expect(part).toMatchObject({ acknowledged: false, acknowledgement: { itemCount: 2 } });
    // A team item slipped into the ids is not recorded.
    const all = await r.acknowledgeClientReport(owner, admin, [
      id.page,
      id.note,
      id.linked,
      id.clientNote,
      id.teamNote,
    ]);
    expect(all.acknowledged).toBe(true);
    expect(all.acknowledgement).toMatchObject({
      itemCount: 4,
      ackedBy: { id: admin, name: 'Ada Admin' },
    });
    expect(await r.clientReportAcknowledged(owner)).toBe(true);
    const rep = await r.clientReport(owner);
    expect(rep).toMatchObject({ acknowledged: true, newSinceAck: [] });
  });

  it('asks again once an item not in it goes to client; an item leaving client does not', async () => {
    await exec(sqlTag`update nodes set audience = 'team' where id = ${id.note}`);
    expect(await r.clientReportAcknowledged(owner)).toBe(true);
    await exec(sqlTag`update nodes set audience = 'client' where id = ${id.later}`);
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
    const rep = await r.clientReport(owner);
    expect(rep.acknowledged).toBe(false);
    expect(rep.newSinceAck).toEqual([id.later]);
  });
});

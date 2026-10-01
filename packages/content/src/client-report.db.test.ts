/**
 * "What clients see" (client logins C1) on a real, migrated Postgres: the
 * report lists every item at client level and nothing else, with its old
 * live link, the old live links ABOVE it (a client folder over it, a client
 * page embedding it), the addresses a page was successfully emailed to, and
 * the team and admin items it names (mention chips and links, plan N6, and
 * a drawing's images and a table's link cells). A ref to an item that is not
 * the brain's never shows its title. The acknowledgement records only what
 * was shown and still is client, or, by the report's fingerprint, the whole
 * client set; the report asks again once an item not in it goes to client.
 * Seeds a brain of its own (the report reads by owner id, on the admin
 * pool) and removes it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/client-report.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the "What clients see" report', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let r: typeof import('./client-report');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const tag = `creport-${owner.slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-creport-'));
  const id = {
    page: randomUUID(), // client, names a team note, an admin page, a client note, a member's item
    note: randomUUID(), // client, links a team note in its markdown
    linked: randomUUID(), // client, an old live link
    teamNote: randomUUID(),
    adminPage: randomUUID(),
    clientNote: randomUUID(),
    later: randomUUID(), // team now, client later
    memberItem: randomUUID(), // a member's personal item (not the brain's)
    draw: randomUUID(), // client, places an admin file
    adminFile: randomUUID(),
    table: randomUUID(), // client, a cell links a team page
    teamPage: randomUUID(),
    folder: randomUUID(), // client folder with an old live link
    folderFile: randomUUID(), // client file inside it
    embPage: randomUUID(), // client page with an old live link, embeds embFile
    embFile: randomUUID(),
  };
  const clientIds = () => [
    id.page,
    id.note,
    id.linked,
    id.clientNote,
    id.draw,
    id.table,
    id.folder,
    id.folderFile,
    id.embPage,
    id.embFile,
  ];
  const share = { folder: randomUUID(), embPage: randomUUID() };
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    m = await import('@mantle/db');
    r = await import('./client-report');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, display_name, role) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', null, 'admin'),
        (${admin}, ${`${tag}-a@example.invalid`}, 'x', 'Ada Admin', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', null, 'member')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    const [ms] = (await exec(sqlTag`
      select id from spaces where kind = 'personal' and login_id = ${member}`)) as unknown as {
      id: string;
    }[];
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: id.teamNote, ref: 'node' } },
            { type: 'mention', attrs: { id: id.clientNote, ref: 'node' } },
            { type: 'mention', attrs: { id: id.memberItem, ref: 'node' } },
            {
              type: 'text',
              text: 'the plan',
              marks: [{ type: 'link', attrs: { href: `/n/${id.adminPage}` } }],
            },
          ],
        },
      ],
    };
    const embDoc = { type: 'doc', content: [{ type: 'image', attrs: { nodeId: id.embFile } }] };
    const folderPath = `files.cr_${owner.slice(0, 8)}`;
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data) values
        (${id.page}, ${owner}, 'page', 'Client page', 'pages', 'client', '{}'::jsonb),
        (${id.note}, ${owner}, 'note', 'Client note one', 'notes', 'client',
         ${JSON.stringify({ content: `see [it](/n/${id.teamNote})` })}::jsonb),
        (${id.linked}, ${owner}, 'page', 'Linked page', 'pages', 'client', '{}'::jsonb),
        (${id.teamNote}, ${owner}, 'note', 'Team secret', 'notes', 'team', '{}'::jsonb),
        (${id.adminPage}, ${owner}, 'page', 'Admin plan', 'pages', 'admin', '{}'::jsonb),
        (${id.clientNote}, ${owner}, 'note', 'Client note two', 'notes', 'client', '{}'::jsonb),
        (${id.later}, ${owner}, 'note', 'Later', 'notes', 'team', '{}'::jsonb),
        (${id.memberItem}, ${ms!.id}, 'note', 'Member private title', 'notes', 'client', '{}'::jsonb),
        (${id.draw}, ${owner}, 'draw', 'Client drawing', 'draws', 'client', '{}'::jsonb),
        (${id.adminFile}, ${owner}, 'file', 'admin.png', 'files', 'admin', '{}'::jsonb),
        (${id.table}, ${owner}, 'table', 'Client table', 'tables', 'client', '{}'::jsonb),
        (${id.teamPage}, ${owner}, 'page', 'Team page', 'pages', 'team', '{}'::jsonb),
        (${id.folder}, ${owner}, 'branch', 'Old client folder', ${folderPath}, 'client', '{}'::jsonb),
        (${id.folderFile}, ${owner}, 'file', 'in-folder.pdf', ${folderPath}, 'client', '{}'::jsonb),
        (${id.embPage}, ${owner}, 'page', 'Old client page', 'pages', 'client', '{}'::jsonb),
        (${id.embFile}, ${owner}, 'file', 'embedded.png', 'files', 'client', '{}'::jsonb)`);
    await exec(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${id.page}, ${JSON.stringify(doc)}::jsonb, ''),
        (${id.linked}, '{"type":"doc","content":[]}'::jsonb, ''),
        (${id.embPage}, ${JSON.stringify(embDoc)}::jsonb, '')`);
    await exec(sqlTag`
      insert into draws (node_id, file_refs)
      values (${id.draw}, ${JSON.stringify({ img1: id.adminFile })}::jsonb)`);
    // A table workbook with one link cell (the shape refLikeCells reads).
    const rel = `${owner}/${id.table}.sqlite`;
    mkdirSync(path.join(root, 'table-dbs', owner), { recursive: true });
    const lite = new DatabaseSync(path.join(root, 'table-dbs', rel));
    lite.exec(`create table _tabs (tab_id text, name text, physical_table text, position int);
      insert into _tabs values ('t1', 'Sheet', 't_1', 0);
      create table t_1 (c1 text);
      insert into t_1 values ('/n/${id.teamPage}'), ('plain words');`);
    lite.close();
    await exec(sqlTag`insert into tables (node_id, storage_path) values (${id.table}, ${rel})`);

    await exec(sqlTag`
      insert into shares (id, owner_id, node_id, node_type, token, view_count) values
        (${randomUUID()}, ${owner}, ${id.linked}, 'page', ${`${tag}-tok`}, 3),
        (${share.folder}, ${owner}, ${id.folder}, 'branch', ${`${tag}-ftok`}, 0),
        (${share.embPage}, ${owner}, ${id.embPage}, 'page', ${`${tag}-ptok`}, 0)`);
    const [t] = (await exec(sqlTag`
      insert into traces (owner_id, kind) values (${owner}, 'responder_turn') returning id`)) as unknown as {
      id: string;
    }[];
    const stepIn = (args: Record<string, string>) =>
      JSON.stringify({ slug: 'email_page', args: { pageId: id.page, ...args } });
    await exec(sqlTag`
      insert into trace_steps (trace_id, ordinal, name, kind, status, input, output) values
        (${t!.id}, 0, 'tool: email_page', 'compute', 'success', ${stepIn({
          to: 'Ann <Ann@Example.invalid>, bob@example.invalid',
          cc: 'cy@example.invalid',
          bcc: '"Dee, D." <dee@example.invalid>',
        })}::jsonb, '{"messageId":"<m1@x>"}'::jsonb),
        (${t!.id}, 1, 'tool: email_page', 'compute', 'skipped',
         ${stepIn({ to: 'queued@example.invalid' })}::jsonb, '{}'::jsonb),
        (${t!.id}, 2, 'tool: email_page', 'compute', 'error',
         ${stepIn({ to: 'failed@example.invalid' })}::jsonb, '{}'::jsonb),
        (${t!.id}, 3, 'tool: email_page', 'compute', 'success',
         ${stepIn({ to: 'nomessage@example.invalid' })}::jsonb, '{}'::jsonb)`);
    // A successful send older than the window is not a hint.
    await exec(sqlTag`
      insert into trace_steps (trace_id, ordinal, name, kind, status, input, output, created_at)
      values (${t!.id}, 4, 'tool: email_page', 'compute', 'success',
              ${stepIn({ to: 'ancient@example.invalid' })}::jsonb,
              '{"messageId":"<m0@x>"}'::jsonb, now() - interval '500 days')`);
  });

  afterAll(async () => {
    await exec(sqlTag`delete from client_report_acks where owner_id = ${owner}`);
    await exec(sqlTag`delete from traces where owner_id = ${owner}`);
    await exec(sqlTag`delete from shares where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner} or id = ${id.memberItem}`);
    await exec(
      sqlTag`delete from spaces where id = ${owner} or login_id in (${owner}, ${admin}, ${member})`,
    );
    await exec(sqlTag`delete from auth.users where id in (${owner}, ${admin}, ${member})`);
    rmSync(root, { recursive: true, force: true });
    await m.closeDb();
  });

  it('lists every client item and nothing else, with links, email hints and refs above', async () => {
    const rep = await r.clientReport(owner);
    expect(rep.total).toBe(clientIds().length);
    expect(rep.items.map((i) => i.id).sort()).toEqual(clientIds().sort());
    const page = rep.items.find((i) => i.id === id.page)!;
    // Successful sends only (not queued, failed or without a message id, not
    // older than the window), to, cc and bcc, display names left out.
    expect(page.emailedTo).toEqual([
      'ann@example.invalid',
      'bob@example.invalid',
      'cy@example.invalid',
      'dee@example.invalid',
    ]);
    expect(page.link).toBeNull();
    // The team note and the admin page it names; the client note is fine.
    // The member's personal item: named, but never its title (audit A8).
    expect(page.refsAbove.map((x) => [x.id, x.audience]).sort()).toEqual(
      [
        [id.adminPage, 'admin'],
        [id.teamNote, 'team'],
        [id.memberItem, null],
      ].sort(),
    );
    expect(page.refsAbove.find((x) => x.id === id.memberItem)).toEqual({
      id: id.memberItem,
      type: null,
      title: null,
      audience: null,
    });
    expect(rep.items.find((i) => i.id === id.note)!.refsAbove).toEqual([
      { id: id.teamNote, type: 'note', title: 'Team secret', audience: 'team' },
    ]);
    const linked = rep.items.find((i) => i.id === id.linked)!;
    expect(linked.link).toMatchObject({ viewCount: 3, lastViewedAt: null });
    expect(rep.acknowledgement).toBeNull();
    expect(rep.acknowledged).toBe(false);
    expect(rep.newSinceAck.sort()).toEqual(clientIds().sort());
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
  });

  it("scans a drawing's images and a table's link cells for refs (audit A24)", async () => {
    const rep = await r.clientReport(owner);
    expect(rep.items.find((i) => i.id === id.draw)!.refsAbove).toEqual([
      { id: id.adminFile, type: 'file', title: 'admin.png', audience: 'admin' },
    ]);
    expect(rep.items.find((i) => i.id === id.table)!.refsAbove).toEqual([
      { id: id.teamPage, type: 'page', title: 'Team page', audience: 'team' },
    ]);
  });

  it('names an old live link on a client folder over an item or a client page embedding it (A11)', async () => {
    const rep = await r.clientReport(owner);
    expect(rep.items.find((i) => i.id === id.folderFile)!.oldLinksAbove).toEqual([
      {
        shareId: share.folder,
        nodeId: id.folder,
        title: 'Old client folder',
        type: 'branch',
        via: 'folder',
      },
    ]);
    expect(rep.items.find((i) => i.id === id.embFile)!.oldLinksAbove).toEqual([
      {
        shareId: share.embPage,
        nodeId: id.embPage,
        title: 'Old client page',
        type: 'page',
        via: 'page',
      },
    ]);
    // The folder and the page carry their own link, nothing above them.
    expect(rep.items.find((i) => i.id === id.folder)!.oldLinksAbove).toBeUndefined();
    expect(rep.items.find((i) => i.id === id.clientNote)!.oldLinksAbove).toBeUndefined();
    // A revoked link is no longer named.
    await exec(sqlTag`update shares set revoked_at = now() where id = ${share.folder}`);
    try {
      const again = await r.clientReport(owner);
      expect(again.items.find((i) => i.id === id.folderFile)!.oldLinksAbove).toBeUndefined();
    } finally {
      await exec(sqlTag`update shares set revoked_at = null where id = ${share.folder}`);
    }
  });

  it('the fingerprint is sha256 of every client id, sorted, joined by commas', async () => {
    const rep = await r.clientReport(owner);
    const want = createHash('sha256').update(clientIds().sort().join(',')).digest('hex');
    expect(rep.fingerprint).toBe(want);
  });

  it('an acknowledgement records only what was shown and is client now', async () => {
    const part = await r.acknowledgeClientReport(owner, admin, [id.page, id.note]);
    expect(part).toMatchObject({ acknowledged: false, acknowledgement: { itemCount: 2 } });
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
    // A team item slipped into the ids is not recorded.
    const all = await r.acknowledgeClientReport(owner, admin, [...clientIds(), id.teamNote]);
    expect(all.acknowledged).toBe(true);
    expect(all.acknowledgement).toMatchObject({
      itemCount: clientIds().length,
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

  it('acknowledges by fingerprint; a stale fingerprint is refused and records nothing', async () => {
    const rep = await r.clientReport(owner);
    // Something changes after the admin loaded the report.
    await exec(sqlTag`update nodes set audience = 'client' where id = ${id.note}`);
    await expect(
      r.acknowledgeClientReport(owner, admin, { fingerprint: rep.fingerprint! }),
    ).rejects.toBeInstanceOf(r.ClientReportChangedError);
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
    const fresh = await r.clientReport(owner);
    const res = await r.acknowledgeClientReport(owner, admin, { fingerprint: fresh.fingerprint! });
    expect(res.acknowledged).toBe(true);
    expect(await r.clientReportAcknowledged(owner)).toBe(true);
  });

  it('counts what a folder shared with clients holds, and asks again when one is shared', async () => {
    const folderId = randomUUID();
    const inside = randomUUID();
    const folderPath = `notes.${tag.replace(/-/g, '_')}_shared`;
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${folderId}, ${owner}, 'branch', 'Shared', ${folderPath}::ltree, '{}'::jsonb),
        (${inside}, ${owner}, 'note', 'Admin note in it', ${folderPath}::ltree, '{}'::jsonb)`);
    // Admin by its own level: not a client item yet.
    expect(await r.clientReportAcknowledged(owner)).toBe(true);
    await exec(sqlTag`update nodes set share_level = 'client' where id = ${folderId}`);
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
    const rep = await r.clientReport(owner);
    expect(rep.items.map((i) => i.id)).toContain(inside);
    expect(rep.newSinceAck).toEqual([inside]);
    const res = await r.acknowledgeClientReport(owner, admin, { fingerprint: rep.fingerprint! });
    expect(res.acknowledged).toBe(true);
  });
});

describe.skipIf(!URL)('the report above the list cap (audit A7)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let r: typeof import('./client-report');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `creport-big-${owner.slice(0, 8)}`;
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    r = await import('./client-report');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, audience, data)
      select ${owner}, 'note', ${tag} || ' ' || g, 'notes', 'client', '{}'::jsonb
        from generate_series(1, ${r.CLIENT_REPORT_MAX + 1}) g`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from client_report_acks where owner_id = ${owner}`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await exec(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('no acknowledgement is never acknowledged, even with no client items', async () => {
    expect(await r.clientReportAcknowledged(randomUUID())).toBe(false);
  });

  it('2001 client items: the list shows 2000, the fingerprint acknowledges all of them', async () => {
    const rep = await r.clientReport(owner);
    expect(rep.total).toBe(r.CLIENT_REPORT_MAX + 1);
    expect(rep.items).toHaveLength(r.CLIENT_REPORT_MAX);
    // Acknowledging only what was shown can never cover the whole set.
    const shown = await r.acknowledgeClientReport(
      owner,
      owner,
      rep.items.map((i) => i.id),
    );
    expect(shown.acknowledged).toBe(false);
    expect(await r.clientReportAcknowledged(owner)).toBe(false);
    // The fingerprint does.
    const res = await r.acknowledgeClientReport(owner, owner, { fingerprint: rep.fingerprint! });
    expect(res).toMatchObject({
      acknowledged: true,
      acknowledgement: { itemCount: r.CLIENT_REPORT_MAX + 1 },
    });
    expect(await r.clientReportAcknowledged(owner)).toBe(true);
    expect((await r.clientReport(owner)).newSinceAck).toEqual([]);
  });
});

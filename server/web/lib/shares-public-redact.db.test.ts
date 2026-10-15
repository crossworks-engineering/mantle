/**
 * An open link shows a page or note only as its served list allows (plan
 * 8.1; before W5b2, as the public might read it, access matrix M7), against
 * a real, migrated Postgres. A page that mentions an item not served, holds
 * a child page card of one and embeds one gives the anonymous visitor no
 * label, title or file name: those say "Private item" (the embed is left
 * out); a served item keeps its title. A task's or an event's body and a
 * task's checklist take the note rule (T18). A contact share reads the item
 * as it is. The list 0262 fills from the frozen levels shows exactly what
 * the level rule showed. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-public-redact.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';
import { renderPageDoc } from './render-page-doc';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('open links redact what the public may not read', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `public-redact-${owner.slice(0, 8)}`;
  const id = {
    page: randomUUID(),
    note: randomUUID(),
    secretPage: randomUUID(),
    secretFile: randomUUID(),
    openPage: randomUUID(),
    task: randomUUID(),
    event: randomUUID(),
  };
  const SECRET = 'Acquisition plan';
  const SECRET_FILE = 'board-minutes.pdf';

  const shareOf = (
    nodeId: string,
    nodeType: string,
    contactId: string | null = null,
    served: string[] = [id.openPage],
  ) =>
    ({
      id: randomUUID(),
      ownerId: owner,
      nodeId,
      nodeType,
      token: 't',
      contactId,
      settings: contactId ? {} : { served },
    }) as unknown as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    // The frozen levels (written on insert) the 0262 fill reads: the page,
    // the note and the open page public, the secret page and file admin.
    const rows: Array<[string, string, string, string, string]> = [
      [id.page, 'page', 'Shared page', 'pages', 'public'],
      [id.note, 'note', 'Shared note', 'notes', 'public'],
      [id.secretPage, 'page', SECRET, 'pages', 'admin'],
      [id.secretFile, 'file', SECRET_FILE, 'files', 'admin'],
      [id.openPage, 'page', 'Open page', 'pages', 'public'],
      [id.task, 'task', 'Shared task', 'tasks', 'admin'],
      [id.event, 'event', 'Shared event', 'events', 'admin'],
    ];
    for (const [nid, type, title, path, audience] of rows) {
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience) values
          (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree, ${audience})`);
    }
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'mention',
              attrs: { id: id.secretPage, label: SECRET, ref: 'node', kind: 'page' },
            },
            { type: 'text', text: ' and ' },
            {
              type: 'mention',
              attrs: { id: id.openPage, label: 'Open page', ref: 'node', kind: 'page' },
            },
          ],
        },
        { type: 'childPage', attrs: { pageId: id.secretPage, title: SECRET } },
        { type: 'fileEmbed', attrs: { nodeId: id.secretFile, filename: SECRET_FILE } },
      ],
    };
    for (const p of [id.page, id.secretPage, id.openPage]) {
      await m.db.execute(
        sqlTag`insert into pages (node_id, doc, doc_text) values (${p}, ${JSON.stringify(p === id.page ? doc : { type: 'doc', content: [] })}::jsonb, '')`,
      );
    }
    const note = `Read [${SECRET}](mention:node:${id.secretPage}) and [Open page](mention:node:${id.openPage}).`;
    await m.db.execute(
      sqlTag`update nodes set data = ${JSON.stringify({ content: note })}::jsonb where id = ${id.note}`,
    );
    const task = {
      body: note,
      status: 'open',
      todos: [{ text: `Draft [${SECRET}](mention:node:${id.secretPage})`, done: false }],
    };
    await m.db.execute(
      sqlTag`update nodes set data = ${JSON.stringify(task)}::jsonb where id = ${id.task}`,
    );
    await m.db.execute(
      sqlTag`update nodes set data = ${JSON.stringify({ body: note })}::jsonb where id = ${id.event}`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const html = async (share: Share) => {
    const view = await shares.loadShareView(share);
    if (view?.kind !== 'page') throw new Error('not a page');
    return renderPageDoc(view.doc, { assetUrl: (f) => `/a/${f}` });
  };

  it('an open page link hides the titles and file names of admin items', async () => {
    const out = await html(shareOf(id.page, 'page'));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET_FILE);
    expect(out).not.toContain(id.secretFile);
    expect(out).toContain('Private item');
    expect(out).toContain('Open page');
  });

  it('an open note link hides them too', async () => {
    const view = await shares.loadShareView(shareOf(id.note, 'note'));
    if (view?.kind !== 'note') throw new Error('not a note');
    expect(view.content).not.toContain(SECRET);
    expect(view.content).toContain('Private item');
    expect(view.content).toContain('Open page');
  });

  it('an open task link hides them in the body and the checklist', async () => {
    const view = await shares.loadShareView(shareOf(id.task, 'task'));
    if (view?.kind !== 'task') throw new Error('not a task');
    expect(view.body).not.toContain(SECRET);
    expect(view.body).toContain('Private item');
    expect(view.body).toContain('Open page');
    expect(view.todos).toHaveLength(1);
    expect(view.todos?.[0]?.text).not.toContain(SECRET);
    expect(view.todos?.[0]?.text).toContain('Private item');
  });

  it('an open event link hides them in the body', async () => {
    const view = await shares.loadShareView(shareOf(id.event, 'event'));
    if (view?.kind !== 'event') throw new Error('not an event');
    expect(view.body).not.toContain(SECRET);
    expect(view.body).toContain('Private item');
    expect(view.body).toContain('Open page');
  });

  it('a contact task share reads the body as it is', async () => {
    const view = await shares.loadShareView(shareOf(id.task, 'task', randomUUID()));
    if (view?.kind !== 'task') throw new Error('not a task');
    expect(view.body).toContain(SECRET);
  });

  it('0262 fills each link with what the level rule showed: the open page only', async () => {
    for (const [nodeId, type] of [
      [id.page, 'page'],
      [id.note, 'note'],
      [id.task, 'task'],
      [id.event, 'event'],
    ] as const) {
      const [row] = (await m.db.execute(sqlTag`
        insert into shares (owner_id, node_id, node_type, token)
        values (${owner}, ${nodeId}, ${type}, ${`${tag}-${type}`}) returning id`)) as unknown as {
        id: string;
      }[];
      // As the superuser: the runtime role (arch A9) may not run the 0262
      // fill's function (the app never calls it).
      const [got] = (await (
        await import('@mantle/db/test-support')
      ).superuserExec(
        URL!,
        sqlTag`select mantle_link_served_by_levels(${row!.id}) as served`,
      )) as unknown as { served: string[] }[];
      expect(got!.served, type).toEqual([id.openPage]);
    }
  });

  it('a served item keeps its title; one taken off the list reads "Private item"', async () => {
    const all = await html(shareOf(id.page, 'page', null, [id.openPage, id.secretPage]));
    expect(all).toContain(SECRET);
    // The file is not on the list: left out, never named.
    expect(all).not.toContain(SECRET_FILE);
    const none = await html(shareOf(id.page, 'page', null, []));
    expect(none).not.toContain('Open page');
    expect(none).toContain('Private item');
  });

  it('a contact share reads the item as it is', async () => {
    const out = await html(shareOf(id.page, 'page', randomUUID()));
    expect(out).toContain(SECRET);
    expect(out).toContain(SECRET_FILE);
  });
});

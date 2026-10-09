/**
 * Which files are email attachments, on a real Postgres (access matrix M4):
 * the lookups the API key paths filter Files by. A file in the attachments
 * folder under a mail is one; a folder that is, is inside or holds one, by
 * id or by path, reaches one; a malformed path is refused. A Files document
 * that also came by mail (sync links it by its bytes) is not one, nor is a
 * plain file or another owner's attachment.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/email-attachments.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('email attachment lookups on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Mod = typeof import('./email-attachments');
  let m: Db;
  let e: Mod;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const other = randomUUID();
  const account = randomUUID();
  const tag = `mail-att-${owner.slice(0, 8)}`;
  const inbox = `inbox.${tag.replace(/-/g, '_')}`;
  const ids = {
    emailNode: randomUUID(),
    email: randomUUID(),
    folder: randomUUID(),
    attachment: randomUUID(),
    plain: randomUUID(),
    emailed: randomUUID(),
    filesFolder: randomUUID(),
    image: randomUUID(),
    table: randomUUID(),
    plainCopy: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    e = await import('./email-attachments');
    sqlTag = (await import('drizzle-orm')).sql;
    for (const id of [owner, other]) {
      await m.db.execute(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${id.slice(0, 4)}@example.invalid`}, 'x', 'admin')`);
      await m.db.execute(
        sqlTag`insert into spaces (id, kind, login_id) values (${id}, 'brain', ${id})`,
      );
    }
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.emailNode}, ${owner}, 'email', 'A mail', ${inbox}),
        (${ids.folder}, ${owner}, 'branch', 'attachments', ${`${inbox}.attachments`}),
        (${ids.attachment}, ${owner}, 'file', 'invoice.pdf', ${`${inbox}.attachments`}),
        (${ids.filesFolder}, ${owner}, 'branch', 'work', ${`files.${tag.replace(/-/g, '_')}`}),
        (${ids.plain}, ${owner}, 'file', 'plan.pdf', ${`files.${tag.replace(/-/g, '_')}`}),
        (${ids.emailed}, ${owner}, 'file', 'contract.pdf', ${`files.${tag.replace(/-/g, '_')}`})`);
    // What the extractor makes from a file: an image beside other files,
    // a Table in the tables tree, each naming its source (T4).
    const from = (id: string) => JSON.stringify({ sourceFileId: id });
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${ids.image}, ${owner}, 'file', 'figure 1', ${`files.${tag.replace(/-/g, '_')}`}, ${from(ids.attachment)}::jsonb),
        (${ids.table}, ${owner}, 'table', 'invoice lines', 'tables', ${from(ids.attachment)}::jsonb),
        (${ids.plainCopy}, ${owner}, 'table', 'plan lines', 'tables', ${from(ids.plain)}::jsonb)`);
    await m.db.execute(sqlTag`
      insert into email_accounts (id, user_id, provider, address, branch_path)
      values (${account}, ${owner}, 'imap', ${`${tag}@example.invalid`}, ${inbox})`);
    await m.db.execute(sqlTag`
      insert into emails (id, node_id, account_id, provider_msg_id, from_addr, internal_date)
      values (${ids.email}, ${ids.emailNode}, ${account}, ${`${tag}-1`}, 'a@example.invalid', now())`);
    await m.db.execute(sqlTag`
      insert into email_attachments (email_id, file_node_id, filename, sha256, storage_key)
      values (${ids.email}, ${ids.attachment}, 'invoice.pdf', 'abc', 'k'),
             (${ids.email}, ${ids.emailed}, 'contract.pdf', 'def', 'k2')`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from email_attachments where email_id = ${ids.email}`);
    await m.db.execute(sqlTag`delete from emails where account_id = ${account}`);
    await m.db.execute(sqlTag`delete from email_accounts where id = ${account}`);
    for (const id of [owner, other]) {
      await m.db.execute(sqlTag`delete from nodes where owner_id = ${id}`);
      await m.db.execute(sqlTag`delete from spaces where id = ${id} or login_id = ${id}`);
      await m.db.execute(sqlTag`delete from auth.users where id = ${id}`);
    }
  });

  it('picks the attachments out of a list of ids', async () => {
    const got = await e.emailAttachmentIds(owner, [
      ids.attachment,
      ids.plain,
      ids.emailed,
      'not-a-uuid',
    ]);
    expect([...got]).toEqual([ids.attachment]);
    expect((await e.emailAttachmentIds(other, [ids.attachment])).size).toBe(0);
    expect((await e.emailAttachmentIds(owner, [])).size).toBe(0);
  });

  it('holds an image or a Table made from an attachment to the attachment (T4)', async () => {
    const got = await e.emailAttachmentIds(owner, [ids.image, ids.table, ids.plainCopy]);
    expect([...got].sort()).toEqual([ids.image, ids.table].sort());
    expect(await e.reachesEmailAttachment(owner, { id: ids.table })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { id: ids.image })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { id: ids.plainCopy })).toBe(false);
    // The folder the image sits in is an ordinary folder all the same.
    expect(await e.reachesEmailAttachment(owner, { path: `files.${tag.replace(/-/g, '_')}` })).toBe(
      false,
    );
    // Moved out of the attachments folder, the source is an ordinary file,
    // and so are the copies.
    await m.db.execute(sqlTag`update nodes set path = ${`files.${tag.replace(/-/g, '_')}`}
      where id = ${ids.attachment}`);
    try {
      expect((await e.emailAttachmentIds(owner, [ids.image, ids.table])).size).toBe(0);
    } finally {
      await m.db.execute(sqlTag`update nodes set path = ${`${inbox}.attachments`}
        where id = ${ids.attachment}`);
    }
  });

  it('sees an attachment by its id, its folder id and its folder path', async () => {
    expect(await e.reachesEmailAttachment(owner, { id: ids.attachment })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { id: ids.folder })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: `${inbox}.attachments` })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: 'inbox' })).toBe(true);
  });

  it('names the attachments folders among folder paths', async () => {
    const got = await e.emailAttachmentFolders(owner, [
      `${inbox}.attachments`,
      inbox,
      'files.attachments',
      `files.${tag.replace(/-/g, '_')}`,
    ]);
    expect([...got]).toEqual([`${inbox}.attachments`]);
  });

  it('refuses a path it cannot read', async () => {
    expect(await e.reachesEmailAttachment(owner, { path: "files'; drop" })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: '' })).toBe(true);
  });

  it('leaves plain files, emailed Files documents, other owners and odd ids alone', async () => {
    expect(await e.reachesEmailAttachment(owner, { id: ids.plain })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { id: ids.emailed })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { id: ids.filesFolder })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { path: 'files' })).toBe(false);
    expect(await e.reachesEmailAttachment(other, { id: ids.attachment })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { id: 'nope' })).toBe(false);
  });
});

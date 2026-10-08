/**
 * Which files are email attachments, on a real Postgres (access matrix M4):
 * the lookups the API key paths filter Files by. A file linked by
 * email_attachments is one; a folder that holds one, by id or by path, holds
 * one; a plain file, another owner's attachment and a malformed ref are not.
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
    filesFolder: randomUUID(),
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
        (${ids.plain}, ${owner}, 'file', 'plan.pdf', ${`files.${tag.replace(/-/g, '_')}`})`);
    await m.db.execute(sqlTag`
      insert into email_accounts (id, user_id, provider, address, branch_path)
      values (${account}, ${owner}, 'imap', ${`${tag}@example.invalid`}, ${inbox})`);
    await m.db.execute(sqlTag`
      insert into emails (id, node_id, account_id, provider_msg_id, from_addr, internal_date)
      values (${ids.email}, ${ids.emailNode}, ${account}, ${`${tag}-1`}, 'a@example.invalid', now())`);
    await m.db.execute(sqlTag`
      insert into email_attachments (email_id, file_node_id, filename, sha256, storage_key)
      values (${ids.email}, ${ids.attachment}, 'invoice.pdf', 'abc', 'k')`);
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
    const got = await e.emailAttachmentIds(owner, [ids.attachment, ids.plain, 'not-a-uuid']);
    expect([...got]).toEqual([ids.attachment]);
    expect((await e.emailAttachmentIds(other, [ids.attachment])).size).toBe(0);
    expect((await e.emailAttachmentIds(owner, [])).size).toBe(0);
  });

  it('sees an attachment by its id, its folder id and its folder path', async () => {
    expect(await e.reachesEmailAttachment(owner, { id: ids.attachment })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { id: ids.folder })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: `${inbox}.attachments` })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: 'inbox' })).toBe(true);
  });

  it('leaves plain files, other owners and odd refs alone', async () => {
    expect(await e.reachesEmailAttachment(owner, { id: ids.plain })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { id: ids.filesFolder })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { path: 'files' })).toBe(false);
    expect(await e.reachesEmailAttachment(other, { id: ids.attachment })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { id: 'nope' })).toBe(false);
    expect(await e.reachesEmailAttachment(owner, { path: "files'; drop" })).toBe(false);
  });
});

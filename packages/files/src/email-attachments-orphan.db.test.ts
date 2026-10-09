/**
 * An email attachment stays one when the owner deletes its email (access
 * matrix T20), on a real, migrated Postgres. Deleting an email node removes
 * its `emails` row and, with it, its `email_attachments` links (FK cascade),
 * but the attachment files stay in the attachments folder. The rule used to
 * need the email just above, so from then on those files counted as ordinary
 * files for a Files-only key and a peer's Files category. Now sync stamps
 * each attachment it makes, migration 0239 stamps those synced before, and a
 * stamped file in an attachments folder is an attachment with or without its
 * email. Moved out of the folder it is an ordinary file, and a Files document
 * that also came by mail (never stamped) stays one. Seeds its own owner and
 * rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/email-attachments-orphan.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('an attachment outlives its email', () => {
  type Db = typeof import('@mantle/db');
  type Mod = typeof import('./email-attachments');
  let m: Db;
  let e: Mod;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const account = randomUUID();
  const tag = `mail-orphan-${owner.slice(0, 8)}`;
  const label = tag.replace(/-/g, '_');
  const inbox = `inbox.${label}`;
  const files = `files.${label}`;
  const ids = {
    emailNode: randomUUID(),
    email: randomUUID(),
    stamped: randomUUID(),
    legacy: randomUUID(),
    emailed: randomUUID(),
    image: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    m = await import('@mantle/db');
    e = await import('./email-attachments');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    // `stamped` as sync writes an attachment now; `legacy` as it did before
    // the stamp; `emailed` a Files document the same mail carried (sync
    // reuses it by its bytes and links it, never stamps it).
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${ids.emailNode}, ${owner}, 'email', 'A mail', ${inbox}, '{}'::jsonb),
        (${ids.stamped}, ${owner}, 'file', 'invoice.pdf', ${`${inbox}.attachments`},
          ${JSON.stringify({ sha256: 'a', emailAttachment: true })}::jsonb),
        (${ids.legacy}, ${owner}, 'file', 'old.pdf', ${`${inbox}.attachments`}, '{"sha256": "b"}'::jsonb),
        (${ids.emailed}, ${owner}, 'file', 'contract.pdf', ${files}, '{"sha256": "c"}'::jsonb),
        (${ids.image}, ${owner}, 'file', 'figure 1', ${files},
          ${JSON.stringify({ sourceFileId: ids.stamped })}::jsonb)`);
    await m.db.execute(sqlTag`
      insert into email_accounts (id, user_id, provider, address, branch_path)
      values (${account}, ${owner}, 'imap', ${`${tag}@example.invalid`}, ${inbox})`);
    await m.db.execute(sqlTag`
      insert into emails (id, node_id, account_id, provider_msg_id, from_addr, internal_date)
      values (${ids.email}, ${ids.emailNode}, ${account}, ${`${tag}-1`}, 'a@example.invalid', now())`);
    await m.db.execute(sqlTag`
      insert into email_attachments (email_id, file_node_id, filename, sha256, storage_key)
      values (${ids.email}, ${ids.stamped}, 'invoice.pdf', 'a', 'k1'),
             (${ids.email}, ${ids.legacy}, 'old.pdf', 'b', 'k2'),
             (${ids.email}, ${ids.emailed}, 'contract.pdf', 'c', 'k3')`);
    // The release's backfill, as the migrate runner applies it on a box
    // that synced mail before the stamp.
    const file = fileURLToPath(
      new URL('../../db/migrations/0239_email_attachment_mark.sql', import.meta.url),
    );
    const parts = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s && !/^(--[^\n]*\n)*SET LOCAL/i.test(s));
    for (const part of parts) await m.db.execute(sqlTag.raw(part));
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from email_attachments where email_id = ${ids.email}`);
    await m.db.execute(sqlTag`delete from emails where account_id = ${account}`);
    await m.db.execute(sqlTag`delete from email_accounts where id = ${account}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('stamps the attachments synced before the stamp, and not the Files document', async () => {
    const rows = (await m.db.execute(sqlTag`
      select id from nodes where owner_id = ${owner} and type = 'file'
        and data->>'emailAttachment' = 'true' order by id`)) as unknown as {
      id: string;
    }[];
    expect(rows.map((r) => r.id).sort()).toEqual([ids.stamped, ids.legacy].sort());
  });

  it('deleting the email removes its links but leaves the attachment files', async () => {
    await m.db.execute(sqlTag`delete from nodes where id = ${ids.emailNode}`);
    const emails = (await m.db.execute(
      sqlTag`select 1 from emails where id = ${ids.email}`,
    )) as unknown as unknown[];
    expect(emails).toHaveLength(0);
    const links = (await m.db.execute(
      sqlTag`select 1 from email_attachments where email_id = ${ids.email}`,
    )) as unknown as unknown[];
    expect(links).toHaveLength(0);
    const left = (await m.db.execute(sqlTag`
      select id from nodes where id in (${ids.stamped}, ${ids.legacy})`)) as unknown as unknown[];
    expect(left).toHaveLength(2);
  });

  it('still counts them, and what was made from them, as attachments', async () => {
    const got = await e.emailAttachmentIds(owner, [
      ids.stamped,
      ids.legacy,
      ids.image,
      ids.emailed,
    ]);
    expect([...got].sort()).toEqual([ids.stamped, ids.legacy, ids.image].sort());
    expect([...(await e.emailAttachmentFolders(owner, [`${inbox}.attachments`]))]).toEqual([
      `${inbox}.attachments`,
    ]);
    expect(await e.reachesEmailAttachment(owner, { path: `${inbox}.attachments` })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { path: 'inbox' })).toBe(true);
    expect(await e.reachesEmailAttachment(owner, { id: ids.emailed })).toBe(false);
  });

  it('a stamped file moved out of the attachments folder is an ordinary file', async () => {
    await m.db.execute(sqlTag`update nodes set path = ${files}::ltree where id = ${ids.stamped}`);
    try {
      expect((await e.emailAttachmentIds(owner, [ids.stamped, ids.image])).size).toBe(0);
    } finally {
      await m.db.execute(
        sqlTag`update nodes set path = ${`${inbox}.attachments`}::ltree where id = ${ids.stamped}`,
      );
    }
  });
});

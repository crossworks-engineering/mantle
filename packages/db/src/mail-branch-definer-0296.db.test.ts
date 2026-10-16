/**
 * 0296: the mail account branches are read through a definer
 * (mantle_mail_branch_holds), on a migrated scratch brain on workspaces.
 *
 *  - the email attachment rule (emailAttachmentSql) runs in a login's scope:
 *    `email_accounts` is no table the workspace role reads, and the rule
 *    answered the database's refusal (42501) there before, so an
 *    area-limited key's list of pages, notes or tables was the opaque 500;
 *  - in that scope the rule still finds a file under a mail account's
 *    branch (one with no stamp and no email above it, audit B4);
 *  - the definer answers whether a path is under (or, inclusive, is) one of
 *    the owner's branches, and only the brain's own in a scope.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/mail-branch-definer-0296.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0296: the mail account branches through a definer', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('./index');
  const owner = randomUUID();
  const file = randomUUID();
  const tag = `mb${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const branch = `inbox.${tag}`;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const holds = async (o: string, path: string, inclusive: boolean) =>
    (
      await x<{ h: boolean }>(
        sql`select "public"."mantle_mail_branch_holds"(${o}, ${path}, ${inclusive}) as h`,
      )
    )[0]!.h;

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    await x(sql`insert into email_accounts (user_id, provider, address, branch_path)
      values (${owner}, 'imap', ${`${tag}-mail@example.invalid`}, ${branch})`);
    // A file in an attachments folder under the account's branch, with no
    // stamp and no email above it (synced before the stamp, its email gone).
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${file}, ${owner}, 'file', 'old attachment',
              ${`${branch}.m1.attachments`}::ltree)`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('answers under, and with inclusive the branch itself; never another owner', async () => {
    expect(await holds(owner, `${branch}.m1.attachments`, false)).toBe(true);
    expect(await holds(owner, branch, false)).toBe(false);
    expect(await holds(owner, branch, true)).toBe(true);
    expect(await holds(owner, `inbox.${tag}x`, true)).toBe(false);
    expect(await holds(randomUUID(), `${branch}.m1.attachments`, false)).toBe(false);
  });

  it('the email attachment rule runs in a login scope and still finds the file', async () => {
    const found = await m.withViewer({ login: owner }, async () =>
      (
        (await m.db.execute(
          sql`select id::text as id from nodes
               where owner_id = ${owner} and id = ${file} and ${m.emailAttachmentSql()}`,
        )) as unknown as { id: string }[]
      ).map((r) => r.id),
    );
    expect(found).toEqual([file]);
  });
});

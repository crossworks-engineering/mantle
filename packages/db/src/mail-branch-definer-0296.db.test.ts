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
 *    the owner's branches, and only the brain's own in a scope;
 *  - in a scope, only for a path where the scope reads an item at or above
 *    it: any other path, in a branch or not, is NULL alike (no probe for
 *    the branch paths), and NULL is the refusing answer for its callers.
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
  const member = randomUUID();
  const memberWs = randomUUID();
  const memberNote = randomUUID();
  const memberPath = `${tag}m.docs`;
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
    // Workspace table writes as the superuser: the app's pools only read them.
    const su = (q: ReturnType<typeof sql>) => ts.superuserExec(scratch!.url, q);
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
    // A member login, the one user of its own workspace, which holds one
    // note outside any mail branch and nothing else here.
    await x(sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', false)`);
    await su(sql`insert into workspaces (id, owner_id, name)
      values (${memberWs}, ${owner}, ${`${tag} member ws`})`);
    await su(sql`delete from workspace_users where login_id = ${member}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${memberWs}, ${member}, false)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${memberNote}, ${owner}, 'note', 'member note', ${memberPath}::ltree)`);
    await m.withHeads([memberNote], 'update', async (tx) => {
      await tx.execute(
        sql`insert into item_grants (node_id, workspace_id) values (${memberNote}, ${memberWs})`,
      );
    });
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

  it('in a scope, answers only where the scope reads an item at or above the path', async () => {
    const ask = (login: string) =>
      m.withViewer(
        { login },
        async () =>
          (
            (await m.db.execute(
              sql`select "public"."mantle_mail_branch_holds"(${owner}, ${`${branch}.m1.attachments`}, false) as in_branch,
                       "public"."mantle_mail_branch_holds"(${owner}, ${`${branch}.m1.attachments.sub`}, true) as below_file,
                       "public"."mantle_mail_branch_holds"(${owner}, ${`inbox.${tag}x.m1`}, true) as no_branch,
                       "public"."mantle_mail_branch_holds"(${owner}, ${memberPath}, true) as member_folder,
                       "public"."mantle_mail_branch_holds"(${owner}, ${`${memberPath}.new`}, true) as member_new,
                       "public"."mantle_mail_branch_holds"(${randomUUID()}, ${memberPath}, true) as other_owner`,
            )) as unknown as Record<string, boolean | null>[]
          )[0],
      );
    // The member reads nothing in the inbox: a branch path and a path in
    // no branch answer alike. Its own folder, and a new one under it, are
    // answered.
    expect(await ask(member)).toEqual({
      in_branch: null,
      below_file: null,
      no_branch: null,
      member_folder: false,
      member_new: false,
      other_owner: null,
    });
    // The owner (Admin) reads the attachment file: the answers before.
    expect(await ask(owner)).toMatchObject({
      in_branch: true,
      below_file: true,
      member_folder: false,
      member_new: false,
      other_owner: null,
    });
  });
});

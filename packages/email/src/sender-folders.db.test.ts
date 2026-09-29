/**
 * The client sign-in sender's Sent folders (client logins audit B4, B19,
 * B28) on a real, migrated Postgres, with the IMAP folder list stood in:
 * choosing an account as the sender leaves its sent-mail folders out of
 * sync and remembers EXACTLY the ones it added; choosing another sender or
 * none puts those back (a folder the admin had excluded before stays out);
 * an allow-list is never touched, so one of only sent folders scans nothing
 * rather than widening to every folder; a mailbox whose folders cannot be
 * listed, or that has no sent folder, is refused with nothing written; the
 * `\Sent` special-use flag wins over the English names. Its own owner and
 * accounts, removed after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/email/src/sender-folders.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FolderLister } from './accounts';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the sign-in sender leaves out, and puts back, its Sent folders', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let accounts: typeof import('./accounts');
  const owner = randomUUID();
  const other = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const foreign = randomUUID();
  const tag = `ccsend-${owner.slice(0, 8)}`;

  const lister =
    (folders: string[], sentFolders: string[] = []): FolderLister =>
    async () => ({ folders, sentFolders });
  const state = async (id: string) =>
    (
      await sql<Row[]>`select imap_excluded_folders as excluded, imap_included_folders as included
                         from email_accounts where id = ${id}`
    )[0] as { excluded: string[]; included: string[] | null };
  const held = async (id: string) =>
    (await sql<Row[]>`select folders from client_signin_sender_folders where account_id = ${id}`)[0]
      ?.folders as string[] | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    accounts = await import('./accounts');
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin'),
      (${other}, ${`${tag}-other@example.invalid`}, 'x', 'admin')`;
    for (const [id, user, excluded, included] of [
      [a, owner, ['Trash', 'Sent'], null],
      [b, owner, ['Trash'], ['INBOX', 'Sent Items']],
      [foreign, other, ['Trash'], null],
    ] as const) {
      await sql`insert into email_accounts
        (id, user_id, provider, address, branch_path, imap_excluded_folders, imap_included_folders)
        values (${id}, ${user}, 'imap', ${`${tag}-${id.slice(0, 4)}@example.invalid`},
                ${`inbox.${tag.replace(/-/g, '_')}_${id.slice(0, 4)}`},
                ${excluded as unknown as string[]}, ${included as unknown as string[] | null})`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from email_accounts where id in (${a}, ${b}, ${foreign})`;
    await sql`delete from spaces where login_id in (${owner}, ${other})`;
    await sql`delete from auth.users where id in (${owner}, ${other})`;
  });

  it('refuses, writing nothing, when the folders cannot be listed or hold no sent folder', async () => {
    const unreadable: FolderLister = async () => {
      throw new Error('IMAP login failed');
    };
    expect(await accounts.excludeSentFolders(owner, a, { list: unreadable })).toMatchObject({
      ok: false,
      reason: 'folders-unreadable',
    });
    expect(
      await accounts.excludeSentFolders(owner, a, { list: lister(['INBOX', 'Archive']) }),
    ).toMatchObject({ ok: false, reason: 'no-sent-folder' });
    expect(
      await accounts.excludeSentFolders(owner, foreign, { list: lister(['Sent']) }),
    ).toMatchObject({ ok: false, reason: 'account-not-found' });
    expect((await state(a)).excluded).toEqual(['Trash', 'Sent']);
    expect(await held(a)).toBeUndefined();
  });

  it('adds only the sent folders not already out, and remembers exactly those', async () => {
    const res = await accounts.excludeSentFolders(owner, a, {
      list: lister(['INBOX', 'Sent', 'INBOX.Sent', 'Trash'], []),
    });
    expect(res).toEqual({ ok: true, excluded: ['Sent', 'INBOX.Sent'], added: ['INBOX.Sent'] });
    expect((await state(a)).excluded).toEqual(['Trash', 'Sent', 'INBOX.Sent']);
    expect(await held(a)).toEqual(['INBOX.Sent']);
  });

  it('never widens an allow-list: one of only sent folders stays as it is (it scans nothing)', async () => {
    const res = await accounts.excludeSentFolders(owner, b, {
      list: lister(['INBOX', 'Sent Items', 'Gesendet'], ['Gesendet']),
    });
    // The \Sent flag wins over the English name.
    expect(res).toMatchObject({ ok: true, added: ['Gesendet'] });
    expect(await state(b)).toEqual({
      excluded: ['Trash', 'Gesendet'],
      included: ['INBOX', 'Sent Items'],
    });
    await sql`update email_accounts set imap_included_folders = ${['Gesendet']} where id = ${b}`;
    await accounts.excludeSentFolders(owner, b, {
      list: lister(['INBOX', 'Gesendet'], ['Gesendet']),
    });
    expect((await state(b)).included).toEqual(['Gesendet']);
    await sql`update email_accounts set imap_included_folders = ${['INBOX', 'Sent Items']} where id = ${b}`;
  });

  it('choosing another sender puts back what the first choice added, and only that', async () => {
    const out = await accounts.restoreSentFolders(owner, b);
    expect(out).toEqual([{ accountId: a, restored: ['INBOX.Sent'] }]);
    // "Sent" was out before the choice: it stays out.
    expect((await state(a)).excluded).toEqual(['Trash', 'Sent']);
    expect(await held(a)).toBeUndefined();
    // The chosen sender keeps its folders out.
    expect((await state(b)).excluded).toEqual(['Trash', 'Gesendet']);
    expect(await held(b)).toEqual(['Gesendet']);
  });

  it('None puts back every held folder; a folder the admin re-included by hand is left alone', async () => {
    await sql`update email_accounts set imap_excluded_folders = ${['Trash']} where id = ${b}`;
    const out = await accounts.restoreSentFolders(owner, null);
    expect(out).toEqual([{ accountId: b, restored: [] }]);
    expect((await state(b)).excluded).toEqual(['Trash']);
    expect(await held(b)).toBeUndefined();
    // Another owner's accounts are never touched.
    expect((await state(foreign)).excluded).toEqual(['Trash']);
  });

  it('planSentFolders previews without writing', async () => {
    const plan = await accounts.planSentFolders(owner, a, { list: lister(['INBOX', 'Sent Mail']) });
    expect(plan).toMatchObject({ ok: true, sentFolders: ['Sent Mail'] });
    expect((await state(a)).excluded).toEqual(['Trash', 'Sent']);
    expect(await held(a)).toBeUndefined();
  });
});

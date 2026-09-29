/**
 * A client sign-in code mail never enters the brain (client logins C2b), on
 * a real, migrated Postgres: the brain's own sender sent it, so the contact
 * gate would let its copy in (own accounts are allowed), in Sent, in All
 * Mail, anywhere. The sync skips it by its Message-ID marker before any
 * fetch; a normal sent mail next to it is ingested as before. The same on
 * the backfill path. A reply or forward of a code mail (the marker in
 * In-Reply-To or References, or the X-Mantle-Client-Code header, on the
 * listing or on the full message) is skipped too, and a sign-in link's code
 * in any ingested mail is blanked (audit B19, K6). The provider is a stand-in; the brain is this file's
 * own and is removed after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/email/src/sync-client-code.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmailAccount } from '@mantle/db';
import type { EmailProvider, RawMessage } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('mail sync skips client sign-in code mails', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let sync: typeof import('./sync');
  let marker: typeof import('./client-code-mail');
  const owner = randomUUID();
  const accountId = randomUUID();
  const tag = `ccsync-${owner.slice(0, 8)}`;
  const address = `${tag}-signin@example.invalid`;
  let account: EmailAccount;

  const message = (id: string, rfcMessageId: string, folder: string): RawMessage => ({
    providerMsgId: `${folder}:${id}`,
    rfcMessageId,
    fromAddr: address,
    toAddrs: [`${tag}-client@example.invalid`],
    subject: `Mail ${id}`,
    internalDate: new Date(),
    folder,
    hasAttachments: false,
    attachments: [],
  });

  const providerOf = (
    messages: RawMessage[],
    full: (id: string) => Record<string, unknown> = () => ({}),
  ) => {
    const fetchFull = vi.fn(async (_a: unknown, id: string) => ({
      bodyText: 'body',
      attachments: [],
      ...full(id),
    }));
    const provider: EmailProvider = {
      async *listSince() {
        for (const msg of messages) yield { message: msg, nextCursor: { raw: {} } };
      },
      fetchFull,
      async *listRecent() {},
      async *listFromSender() {
        for (const msg of messages) yield msg;
      },
    };
    return { provider, fetchFull };
  };

  const stored = async () =>
    (
      await sql<Row[]>`select subject, rfc_message_id from emails where account_id = ${accountId}
                      order by subject`
    ).map((r) => r.subject);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    sync = await import('./sync');
    marker = await import('./client-code-mail');
    await sql`insert into auth.users (id, email, password_hash, role)
              values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await sql`insert into email_accounts (id, user_id, provider, address, branch_path)
              values (${accountId}, ${owner}, 'imap', ${address}, ${`inbox.${tag.replace(/-/g, '_')}`})`;
    const [row] = await m.db
      .select()
      .from(m.emailAccounts)
      .where(m.eq(m.emailAccounts.id, accountId))
      .limit(1);
    account = row!;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from emails where account_id = ${accountId}`;
    await sql`delete from sync_runs where account_id = ${accountId}`;
    await sql`delete from email_accounts where id = ${accountId}`;
    await sql`delete from nodes where owner_id = ${owner}`;
    await sql`delete from spaces where login_id = ${owner}`;
    await sql`delete from auth.users where id = ${owner}`;
  });

  it('skips the code mail in every folder and ingests the normal one', async () => {
    const codeId = marker.clientCodeMessageId(address).slice(1, -1);
    const { provider, fetchFull } = providerOf([
      message('1', codeId, 'Sent'),
      message('2', codeId, '[Gmail]/All Mail'),
      message('3', `normal-${tag}@example.invalid`, 'Sent'),
    ]);
    const res = await sync.syncAccount(account, provider);
    expect(res).toEqual({ scanned: 3, ingested: 1 });
    expect(await stored()).toEqual(['Mail 3']);
    // Nothing of the code mail was fetched.
    expect(fetchFull).toHaveBeenCalledTimes(1);
    expect(fetchFull).toHaveBeenCalledWith(account, 'Sent:3');
  });

  it('skips it on the backfill path too', async () => {
    const codeId = marker.clientCodeMessageId(address).slice(1, -1);
    const { provider, fetchFull } = providerOf([message('4', codeId, 'INBOX')]);
    await sync.backfillMatch(account, provider, address);
    expect(fetchFull).not.toHaveBeenCalled();
    expect(await stored()).toEqual(['Mail 3']);
  });

  it('skips a reply or forward of a code mail, and a mail with the code header (B19)', async () => {
    const codeId = marker.clientCodeMessageId(address);
    const { provider, fetchFull } = providerOf([
      { ...message('5', `reply-${tag}@example.invalid`, 'INBOX'), inReplyTo: codeId },
      {
        ...message('6', `fwd-${tag}@example.invalid`, 'INBOX'),
        references: `<a@example.invalid> ${codeId}`,
      },
      { ...message('7', `hdr-${tag}@example.invalid`, 'Sent'), clientCodeHeader: true },
    ]);
    await sync.syncAccount(account, provider);
    expect(fetchFull).not.toHaveBeenCalled();
    expect(await stored()).toEqual(['Mail 3']);
  });

  it('skips it when only the full message shows it (a provider without the headers)', async () => {
    const { provider, fetchFull } = providerOf(
      [message('8', `late-${tag}@example.invalid`, 'INBOX')],
      () => ({ clientCodeMail: true }),
    );
    await sync.syncAccount(account, provider);
    expect(fetchFull).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual(['Mail 3']);
  });

  it('blanks a sign-in link code in the mail it stores (K6)', async () => {
    const link = 'https://brain.example.invalid/client-signin?code=Live7Code9Here';
    const invite = 'https://brain.example.invalid/invite#code=Invite7Code';
    const { provider } = providerOf(
      [
        {
          ...message('9', `link-${tag}@example.invalid`, 'Sent'),
          subject: `Mail 9 ${link}`,
          snippet: `Your link ${link}`,
        },
      ],
      () => ({
        bodyText: `Sign in here: ${link}\nor join: ${invite}`,
        bodyHtml: `<a href="${link}">Sign in</a>`,
      }),
    );
    await sync.syncAccount(account, provider);
    const [row] = await sql<Row[]>`
      select e.subject, e.snippet, e.body_text, e.body_html, n.title
        from emails e join nodes n on n.id = e.node_id
       where e.account_id = ${accountId} and e.subject like 'Mail 9%'`;
    expect(row).toBeDefined();
    const all = JSON.stringify(row);
    expect(all).not.toContain('Live7Code9Here');
    expect(all).not.toContain('Invite7Code');
    expect(row!.body_text).toContain('client-signin?code=[redacted]');
    expect(row!.body_text).toContain('invite#code=[redacted]');
  });
});

/**
 * The client sign-in code job (client logins C2b) on a real, migrated
 * Postgres, as the email-sync worker runs it, with the SMTP send stood in:
 * nothing happens without a sign-in sender; a client's code is mailed to
 * the login's own address from the sender, with the Message-ID marker the
 * mail sync skips and the code in the text (the stored hash matches it);
 * a stranger or a member gets no mail; a failed send revokes the code.
 * Uses the shared test anchor, with its own email account; the sender
 * preference is cleared again at the end.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/client-codes.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the client sign-in code job', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let jobs: typeof import('./client-codes');
  let content: typeof import('@mantle/content');
  const tag = `ccjob-${randomUUID().slice(0, 8)}`;
  const emailOf = (s: string) => `${tag}-${s}@example.invalid`;
  const client = randomUUID();
  const member = randomUUID();
  const account = randomUUID();
  let anchor = '';

  const job = (who: string) => ({
    email: emailOf(who),
    requestId: randomUUID(),
    ip: `203.0.113.${Math.floor(Math.random() * 200)}`,
    requestedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${client}, ${emailOf('client')}, 'x', 'client'),
      (${member}, ${emailOf('member')}, 'x', 'member')`;
    await sql`insert into email_accounts
      (id, user_id, provider, address, display_name, imap_config_enc, smtp_host, smtp_port, branch_path)
      values (${account}, ${anchor}, 'imap', ${emailOf('signin')}, 'Sign-in', 'sealed',
              'smtp.example.invalid', 587, ${`inbox.${tag.replace(/-/g, '_')}`})`;
    jobs = await import('./client-codes');
    content = await import('@mantle/content');
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await content?.savePreferencesFor(anchor, { clientSigninSenderId: '' });
    await sql`delete from email_accounts where id = ${account}`;
    for (const id of [client, member]) {
      await sql`delete from spaces where login_id = ${id}`;
      await sql`delete from auth.users where id = ${id}`;
    }
  });

  it('does nothing while no sender is chosen', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: '' });
    const send = vi.fn();
    expect(await jobs.runClientCodeJob(job('client'), { send })).toEqual({
      kind: 'skipped',
      reason: 'no-sender',
    });
    expect(send).not.toHaveBeenCalled();
    const [n] = await sql<
      Row[]
    >`select count(*)::int as n from client_signin_codes where login_id = ${client}`;
    expect(n!.n).toBe(0);
  });

  it("mails a client's code to the login from the sender, with the sync marker", async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    expect((await jobs.loadClientSigninSender())?.id).toBe(account);
    const send = vi.fn(async () => ({ messageId: 'x', accepted: [], rejected: [] }));
    const j = job('client');
    expect(await jobs.runClientCodeJob(j, { send })).toEqual({ kind: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    const [from, mail] = send.mock.calls[0]! as unknown as [
      { id: string },
      { to: string; text: string; messageId: string; headers: Record<string, string> },
    ];
    expect(from.id).toBe(account);
    expect(mail.to).toBe(emailOf('client'));
    const { isClientCodeMail } = await import('@mantle/email');
    expect(isClientCodeMail({ rfcMessageId: mail.messageId })).toBe(true);
    expect(mail.headers).toEqual({ 'X-Mantle-Client-Code': '1' });
    const code = /^\s+(\d{8})$/m.exec(mail.text)![1]!;
    const [row] = await sql<Row[]>`
      select code_hash from client_signin_codes where request_id = ${j.requestId}`;
    expect(row!.code_hash).toBe(
      createHash('sha256').update(`${j.requestId}:${code}`, 'utf8').digest('hex'),
    );
  });

  it('mails nothing for a stranger or a member', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    const send = vi.fn();
    expect(await jobs.runClientCodeJob(job('stranger'), { send })).toEqual({
      kind: 'skipped',
      reason: 'not-a-client',
    });
    expect(await jobs.runClientCodeJob(job('member'), { send })).toEqual({
      kind: 'skipped',
      reason: 'not-a-client',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('revokes the code when the mail fails', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    const send = vi.fn(async () => {
      throw new Error('SMTP refused');
    });
    const j = { ...job('client'), ip: '198.51.100.250' };
    expect(await jobs.runClientCodeJob(j, { send })).toEqual({ kind: 'failed' });
    const [row] = await sql<Row[]>`
      select revoked_at from client_signin_codes where request_id = ${j.requestId}`;
    expect(row!.revoked_at).not.toBeNull();
  });

  it('turns codes off when the sender can no longer send', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    await sql`update email_accounts set enabled = false where id = ${account}`;
    expect(await jobs.loadClientSigninSender()).toBeNull();
    await sql`update email_accounts set enabled = true where id = ${account}`;
    expect((await jobs.clientSenderCandidates()).map((a) => a.id)).toContain(account);
  });
});

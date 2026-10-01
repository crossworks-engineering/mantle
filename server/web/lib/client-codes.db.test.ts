/**
 * The client sign-in code job (client logins C2b) on a real, migrated
 * Postgres, as the email-sync worker runs it, with the SMTP send stood in:
 * nothing happens without a sign-in sender; a client's code is mailed to
 * the login's own address from the sender, with the Message-ID marker the
 * mail sync skips and the code in the text (the stored hash matches it),
 * and the mail is recorded as sent; a stranger or a member gets no mail; a
 * failed send revokes the code and keeps the reason. And the whole path
 * through the REAL queue (audit B28): the request route queues, the worker
 * handler makes and mails the code (only the SMTP send stood in), the
 * verify route signs the client in; the finished job is what tells the
 * brain an email worker serves the queue (B3).
 * Uses the shared test anchor, with its own email account; the sender
 * preference is cleared again at the end.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/client-codes.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor, pollUntil } from '@mantle/db/test-support';

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
  let savedSecret: string | undefined;

  const job = (who: string) => ({
    email: emailOf(who),
    requestId: randomUUID(),
    ip: `203.0.113.${Math.floor(Math.random() * 200)}`,
    requestedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'client-codes-job-db-test-secret-at-least-32-chars';
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
    await jobs?.closeClientCodeQueue().catch(() => {});
    if (savedSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSecret;
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
      select code_hash, sent_at, send_error from client_signin_codes
       where request_id = ${j.requestId}`;
    expect(row!.code_hash).toBe(content.hashClientCode(j.requestId, code));
    expect(row!.code_hash).not.toBe(
      createHash('sha256').update(`${j.requestId}:${code}`, 'utf8').digest('hex'),
    );
    // The mail server took it: recorded as sent (the card counts it, B3).
    expect(row!.sent_at).not.toBeNull();
    expect(row!.send_error).toBeNull();
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
      select revoked_at, sent_at, send_error from client_signin_codes
       where request_id = ${j.requestId}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.sent_at).toBeNull();
    expect(row!.send_error).toBe('SMTP refused');
  });

  it('turns codes off when the sender can no longer send', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    await sql`update email_accounts set enabled = false where id = ${account}`;
    expect(await jobs.loadClientSigninSender()).toBeNull();
    await sql`update email_accounts set enabled = true where id = ${account}`;
    expect((await jobs.clientSenderCandidates()).map((a) => a.id)).toContain(account);
  });

  it('request -> queue -> worker -> code -> verify, through the real pg-boss queue (B28)', async () => {
    await content.savePreferencesFor(anchor, { clientSigninSenderId: account });
    const { PgBoss } = await import('pg-boss');
    const worker = new PgBoss({ connectionString: URL!, schema: 'pgboss' });
    await worker.start();
    const mails: Array<{ to: string; text: string }> = [];
    const send = vi.fn(async (_from: unknown, mail: { to: string; text: string }) => {
      mails.push(mail);
      return { messageId: 'x', accepted: [mail.to], rejected: [] };
    });
    try {
      await jobs.workClientCodeQueue(worker, { send: send as never });
      const { POST: request } = await import('@/app/api/auth/client-code/route');
      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
      const asked = await request(
        new Request('https://brain.example.invalid/api/auth/client-code', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email: emailOf('client').toUpperCase() }),
        }),
      );
      expect(asked.status).toBe(200);
      const requestId = /mantle_code_req=([^;]*)/.exec(asked.headers.get('set-cookie') ?? '')![1]!;

      await pollUntil(() => mails.length > 0, { timeoutMs: 45_000, what: 'the code mail' });
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(emailOf('client'));
      const code = /^\s+(\d{8})$/m.exec(mails[0]!.text)![1]!;
      const [row] = await sql<Row[]>`
        select login_id, request_ip, sent_at from client_signin_codes where request_id = ${requestId}`;
      expect(row).toMatchObject({ login_id: client, request_ip: ip });
      expect(row!.sent_at).not.toBeNull();

      const { POST: verify } = await import('@/app/api/auth/client-code/verify/route');
      const signedIn = await verify(
        new Request('https://brain.example.invalid/api/auth/client-code/verify', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
            cookie: `mantle_code_req=${requestId}`,
          },
          body: JSON.stringify({ email: emailOf('client'), code }),
        }),
      );
      expect(signedIn.status).toBe(200);
      expect(signedIn.headers.get('set-cookie') ?? '').toMatch(/mantle_session=[^;]+/);

      // A finished code job within 10 minutes: an email worker serves the queue.
      await pollUntil(
        async () =>
          (
            await sql<Row[]>`select count(*)::int as n from pgboss.job
                              where name = ${jobs.CLIENT_CODE_QUEUE} and state = 'completed'`
          )[0]!.n !== 0,
        { timeoutMs: 20_000, what: 'the job to complete' },
      );
      expect(await jobs.emailWorkerServesCodes()).toBe(true);
      // The queue keeps finished jobs a day, not pg-boss's week (B21).
      const [queue] = await sql<Row[]>`
        select retention_seconds, deletion_seconds from pgboss.queue
         where name = ${jobs.CLIENT_CODE_QUEUE}`;
      expect(queue).toMatchObject({ retention_seconds: 3600, deletion_seconds: 86400 });
      // Once the worker's last job is older than 10 minutes, it no longer counts.
      await sql`update pgboss.job
                   set completed_on = now() - interval '1 hour',
                       started_on = now() - interval '1 hour'
                 where name in (${jobs.CLIENT_CODE_QUEUE}, 'mantle.email.scheduler')`;
      expect(await jobs.emailWorkerServesCodes()).toBe(false);
    } finally {
      await worker.stop({ graceful: false, timeout: 5000 }).catch(() => {});
    }
  }, 90_000);
});

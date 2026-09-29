/**
 * The client sign-in code mail (client logins C2b): the code on a line of
 * its own, the brain's name, the ten minutes and the one browser; nothing
 * else a client would need to ask about.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientCodeMail } from './client-codes';

describe('clientCodeMail', () => {
  it('names the brain and holds the code on its own line', () => {
    const mail = clientCodeMail({ siteName: 'Acme brain', code: '01234567' });
    expect(mail.subject).toBe('Your sign-in code for Acme brain');
    expect(mail.text.split('\n')).toContain('    01234567');
    expect(mail.text).toMatch(/10 minutes/);
    expect(mail.text).toMatch(/browser where you asked/);
  });

  it('reads well without a site name', () => {
    expect(clientCodeMail({ siteName: '  ', code: '1' }).subject).toBe(
      'Your sign-in code for your workspace',
    );
  });
});

/**
 * The job's order (client logins audit B20): everything that can fail before
 * the mail is read BEFORE a code is stored, and anything that throws after
 * the code is stored revokes it with the reason, so a retried job never
 * finds an open code no mail carried (which blocked that email and address
 * for 10 minutes). A mail that went out is recorded as sent; a failure to
 * record it never revokes a code the client already has.
 */
describe('runClientCodeJob order (B20)', () => {
  const ANCHOR = '33333333-3333-4333-8333-333333333333';
  const SENDER = {
    id: '77777777-7777-4777-8777-777777777777',
    address: 'signin@example.invalid',
    enabled: true,
    provider: 'imap',
    smtpHost: 'smtp.example.invalid',
    smtpPort: 587,
    imapConfigEnc: 'sealed',
    userId: ANCHOR,
  };
  const JOB = {
    email: 'client@example.invalid',
    requestId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    ip: '203.0.113.1',
    requestedAt: new Date().toISOString(),
  };

  const load = async (opts: { prefsThrowAfter?: number } = {}) => {
    vi.resetModules();
    const calls: string[] = [];
    let prefsReads = 0;
    vi.doMock('@mantle/db', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      resolveSingleOwnerId: vi.fn(async () => ANCHOR),
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [SENDER] }) }) }),
      },
    }));
    const content = {
      loadPreferencesFor: vi.fn(async () => {
        prefsReads += 1;
        calls.push('prefs');
        if (opts.prefsThrowAfter !== undefined && prefsReads > opts.prefsThrowAfter) {
          throw new Error('prefs down');
        }
        return { clientSigninSenderId: SENDER.id, siteName: 'Acme' };
      }),
      createClientEmailCode: vi.fn(async () => {
        calls.push('create');
        return {
          kind: 'send',
          codeId: 'code-1',
          code: '01234567',
          loginId: 'l1',
          email: 'client@example.invalid',
          displayName: null,
          expiresAt: new Date(),
        };
      }),
      revokeClientEmailCode: vi.fn(async (_id: string, _now: Date, reason?: string) => {
        calls.push(`revoke:${reason}`);
      }),
      markClientEmailCodeSent: vi.fn(async () => {
        calls.push('sent');
      }),
    };
    vi.doMock('@mantle/content', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ...content,
    }));
    const mod = await import('./client-codes');
    return { mod, calls, content };
  };

  afterEach(() => {
    vi.doUnmock('@mantle/db');
    vi.doUnmock('@mantle/content');
  });

  it('reads the site name before it stores a code: a read that throws stores nothing', async () => {
    // The first read is the sender's preference; the second the site name.
    const { mod, content } = await load({ prefsThrowAfter: 1 });
    const send = vi.fn();
    await expect(mod.runClientCodeJob(JOB, { send })).rejects.toThrow('prefs down');
    expect(content.createClientEmailCode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('passes the anchor it read to the code, so nothing is resolved after', async () => {
    const { mod, calls, content } = await load();
    const send = vi.fn(async () => ({ messageId: 'x', accepted: [], rejected: [] }));
    expect(await mod.runClientCodeJob(JOB, { send })).toEqual({ kind: 'sent' });
    expect(content.createClientEmailCode).toHaveBeenCalledWith(JOB, expect.any(Date), {
      ownerId: ANCHOR,
    });
    expect(calls).toEqual(['prefs', 'prefs', 'create', 'sent']);
  });

  it('revokes the stored code, with the reason, when the send throws', async () => {
    const { mod, calls } = await load();
    const send = vi.fn(async () => {
      throw new Error('535 authentication failed');
    });
    expect(await mod.runClientCodeJob(JOB, { send })).toEqual({ kind: 'failed' });
    expect(calls).toEqual(['prefs', 'prefs', 'create', 'revoke:535 authentication failed']);
  });

  it('a failure to record a sent mail does not revoke the code', async () => {
    const { mod, calls, content } = await load();
    content.markClientEmailCodeSent.mockRejectedValueOnce(new Error('db blip'));
    const send = vi.fn(async () => ({ messageId: 'x', accepted: [], rejected: [] }));
    expect(await mod.runClientCodeJob(JOB, { send })).toEqual({ kind: 'sent' });
    expect(calls.some((c) => c.startsWith('revoke'))).toBe(false);
  });
});

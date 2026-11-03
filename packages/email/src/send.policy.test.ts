/**
 * The one gate of outbound mail (docs/policy.md, "Email sending"): with
 * MANTLE_POLICY_EMAIL_SEND=off the SMTP transport refuses before it opens a
 * connection, whoever calls it, and the refusal answers 403 with the
 * policy's code on every surface. With no rule it sends as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';
import { domainErrorAnswer } from '@mantle/std';
import type { EmailAccount } from '@mantle/db';

const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: '<m1@example.com>' })));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
vi.mock('nodemailer', () => ({ default: { createTransport } }));
vi.mock('./providers/imap', () => ({ unsealImapPassword: () => 'app-password' }));

const { sendEmail, assertEmailSendAllowed, EmailSendPolicyOffError, EMAIL_SEND_POLICY_OFF_CODE } =
  await import('./send');

const account = {
  address: 'me@example.com',
  displayName: null,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  imapConfigEnc: 'sealed',
} as unknown as EmailAccount;
const message = { to: 'friend@example.com', subject: 'Hi', text: 'Hello' };

const saved = process.env.MANTLE_POLICY_EMAIL_SEND;
function setEmailSend(v: string | undefined): void {
  if (v === undefined) delete process.env.MANTLE_POLICY_EMAIL_SEND;
  else process.env.MANTLE_POLICY_EMAIL_SEND = v;
  resetBoxPolicyForTests();
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => setEmailSend(saved));

describe('MANTLE_POLICY_EMAIL_SEND', () => {
  it('no rule: sendEmail sends as before', async () => {
    setEmailSend(undefined);
    expect(() => assertEmailSendAllowed()).not.toThrow();
    const res = await sendEmail(account, message);
    expect(res.messageId).toBe('<m1@example.com>');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('off: sendEmail refuses before any connection is made', async () => {
    setEmailSend('off');
    await expect(sendEmail(account, message)).rejects.toBeInstanceOf(EmailSendPolicyOffError);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('off: the refusal answers 403 with the policy code', () => {
    setEmailSend('off');
    let caught: unknown;
    try {
      assertEmailSendAllowed();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailSendPolicyOffError);
    const answer = domainErrorAnswer(caught);
    expect(answer?.status).toBe(403);
    expect(answer?.body).toEqual({
      error: "Email sending is switched off by this box's policy (MANTLE_POLICY_EMAIL_SEND).",
      code: EMAIL_SEND_POLICY_OFF_CODE,
    });
    expect(EMAIL_SEND_POLICY_OFF_CODE).toBe('policy_email_send_off');
  });

  it('a value it cannot read refuses too (a worker that boots anyway)', async () => {
    setEmailSend('of');
    await expect(sendEmail(account, message)).rejects.toBeInstanceOf(EmailSendPolicyOffError);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

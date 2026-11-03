/**
 * The Graph transport under the box policy (docs/policy.md, "Email
 * sending"): with MANTLE_POLICY_EMAIL_SEND=off sendViaGraph refuses before
 * any Graph call, through the same gate as SMTP (@mantle/email
 * assertEmailSendAllowed). With no rule it posts as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';
import { EmailSendPolicyOffError } from '@mantle/email';
import type { EmailAccount } from '@mantle/db';

const graphPost = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../client', () => ({ graphPost }));

const { sendViaGraph } = await import('./send');

const account = {
  userId: 'owner-1',
  msAccountId: 'ms-1',
  address: 'me@example.com',
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

describe('MANTLE_POLICY_EMAIL_SEND on the Graph transport', () => {
  it('no rule: posts sendMail as before', async () => {
    setEmailSend(undefined);
    await sendViaGraph(account, message);
    expect(graphPost).toHaveBeenCalledTimes(1);
    expect(graphPost.mock.calls[0]).toEqual(
      expect.arrayContaining(['owner-1', 'ms-1', '/me/sendMail']),
    );
  });

  it('off: refuses before any Graph call', async () => {
    setEmailSend('off');
    await expect(sendViaGraph(account, message)).rejects.toBeInstanceOf(EmailSendPolicyOffError);
    expect(graphPost).not.toHaveBeenCalled();
  });
});

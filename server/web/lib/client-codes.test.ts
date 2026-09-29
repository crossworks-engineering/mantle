/**
 * The client sign-in code mail (client logins C2b): the code on a line of
 * its own, the brain's name, the ten minutes and the one browser; nothing
 * else a client would need to ask about.
 */
import { describe, expect, it } from 'vitest';
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

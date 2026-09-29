/**
 * The client sign-in code mail marker (client logins C2b): every code mail's
 * Message-ID carries it, the sync skips any message that has it, and no
 * other Message-ID matches. And the sent-folder names a sender's sync
 * leaves out.
 */
import { describe, expect, it } from 'vitest';
import { clientCodeMessageId, isClientCodeMail, sentFolderNames } from './client-code-mail';

describe('client code mail marker', () => {
  it('marks every code mail, with or without angle brackets, any case', () => {
    const id = clientCodeMessageId('signin@example.invalid');
    expect(id).toMatch(/^<mantle-client-code\.[0-9a-f-]{36}@example\.invalid>$/);
    expect(isClientCodeMail({ rfcMessageId: id })).toBe(true);
    expect(isClientCodeMail({ rfcMessageId: id.slice(1, -1) })).toBe(true);
    expect(isClientCodeMail({ rfcMessageId: id.toUpperCase() })).toBe(true);
    expect(clientCodeMessageId('signin@example.invalid')).not.toBe(id);
  });

  it('matches no other mail', () => {
    for (const other of [
      undefined,
      null,
      '',
      'CAF=abc@mail.example.invalid',
      '<20260929.1234@example.invalid>',
      'x-mantle-client-code.1@example.invalid',
      'mantle-client-codes@example.invalid',
    ]) {
      expect(isClientCodeMail({ rfcMessageId: other }), String(other)).toBe(false);
    }
  });

  it('finds the sent-mail folders by their usual names', () => {
    expect(
      sentFolderNames([
        'INBOX',
        'INBOX.Sent',
        'Sent',
        'Sent Items',
        '[Gmail]/Sent Mail',
        'Sent Messages',
        'Archive',
        'Resent',
        'INBOX.Sentences',
        'Drafts',
      ]),
    ).toEqual(['INBOX.Sent', 'Sent', 'Sent Items', '[Gmail]/Sent Mail', 'Sent Messages']);
  });
});

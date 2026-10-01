/**
 * The client sign-in code mail marker (client logins C2b): every code mail's
 * Message-ID carries it, the sync skips any message that has it, and no
 * other Message-ID matches. And the sent-folder names a sender's sync
 * leaves out.
 */
import { describe, expect, it } from 'vitest';
import {
  clientCodeMessageId,
  isClientCodeMail,
  pickSentFolders,
  redactSigninCodes,
  sentFolderNames,
  touchesClientCodeMail,
} from './client-code-mail';

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

describe('touchesClientCodeMail (audit B19)', () => {
  const id = clientCodeMessageId('signin@example.invalid');

  it('catches the code mail by its header, and a reply or forward by its references', () => {
    expect(touchesClientCodeMail({ rfcMessageId: id })).toBe(true);
    expect(touchesClientCodeMail({ rfcMessageId: 'x@y', clientCodeHeader: true })).toBe(true);
    expect(touchesClientCodeMail({ rfcMessageId: 'reply@y', inReplyTo: id })).toBe(true);
    expect(
      touchesClientCodeMail({
        rfcMessageId: 'fwd@y',
        references: `<a@example.invalid> ${id} <b@example.invalid>`,
      }),
    ).toBe(true);
    expect(touchesClientCodeMail({ references: id.slice(1, -1).toUpperCase() })).toBe(true);
  });

  it('lets every other mail through', () => {
    expect(touchesClientCodeMail({ rfcMessageId: 'a@b' })).toBe(false);
    expect(
      touchesClientCodeMail({
        rfcMessageId: 'a@b',
        clientCodeHeader: false,
        inReplyTo: '<thread@example.invalid>',
        references: '<x@example.invalid> <not-mantle-client-code.1@example.invalid>',
      }),
    ).toBe(false);
    expect(touchesClientCodeMail({})).toBe(false);
  });
});

describe('redactSigninCodes (audit K6)', () => {
  it('blanks the code of a sign-in link and an invite link, query or fragment', () => {
    const text = [
      'Sign in: https://brain.example.invalid/client-signin?code=AbC-123_xyz',
      'or https://brain.example.invalid/client-signin#code=AbC-123_xyz.',
      'Join: https://brain.example.invalid/invite?code=Zz9&next=/home',
      'Also /client-signin?x=1&code=QQQ and <a href="/invite?code=RRR">here</a>',
      'HTML: /client-signin?x=1&amp;code=SSS',
    ].join('\n');
    const out = redactSigninCodes(text);
    for (const secret of ['AbC-123_xyz', 'Zz9', 'QQQ', 'RRR', 'SSS']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('/client-signin?code=[redacted]');
    expect(out).toContain('/client-signin#code=[redacted].');
    expect(out).toContain('/invite?code=[redacted]&next=/home');
    expect(out).toContain('href="/invite?code=[redacted]"');
  });

  it('leaves other text and empty values alone', () => {
    expect(redactSigninCodes('a ?code=1 elsewhere, /pair?code=2')).toBe(
      'a ?code=1 elsewhere, /pair?code=2',
    );
    expect(redactSigninCodes(undefined)).toBeUndefined();
    expect(redactSigninCodes(null)).toBeNull();
    expect(redactSigninCodes('')).toBe('');
  });
});

describe('pickSentFolders (audit B19)', () => {
  it('takes the \\Sent-flagged folders first, in any language', () => {
    expect(pickSentFolders(['INBOX', 'Gesendet', 'Sent'], ['Gesendet'])).toEqual(['Gesendet']);
  });

  it('falls back to the usual names when nothing is flagged', () => {
    expect(pickSentFolders(['INBOX', 'INBOX.Sent', 'Archive'], [])).toEqual(['INBOX.Sent']);
    expect(pickSentFolders(['INBOX', 'Gesendet'])).toEqual([]);
  });

  it('ignores a flagged folder the listing does not hold', () => {
    expect(pickSentFolders(['INBOX', 'Sent Items'], ['Ghost'])).toEqual(['Sent Items']);
  });
});

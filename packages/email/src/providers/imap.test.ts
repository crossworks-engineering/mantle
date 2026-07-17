/**
 * Tests for the pure helpers inside the IMAP provider.
 *
 * The IMAP integration itself — fetching, folder discovery, envelope
 * normalisation against a real Gmail / Fastmail server — is verified live
 * during sync (see docs/email-ingest.md §10). This file covers the
 * deterministic helpers that decide what we store, where every byte of
 * input variance has to land in the same canonical place:
 *
 *   - `normalizeRfcMessageId` — the cross-folder dedup key
 *     (`(account_id, rfc_message_id)` partial unique index, migration 0045).
 *     If two IMAP servers return the same logical Message-ID differently
 *     wrapped (one with angle brackets, one without; one with surrounding
 *     whitespace, one bare), the dedup MUST collapse them — otherwise we'd
 *     get the same message indexed twice depending on which folder it was
 *     pulled from.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRfcMessageId, parseHeaderBlock } from './imap';

describe('normalizeRfcMessageId', () => {
  it('strips surrounding angle brackets (the common IMAP envelope shape)', () => {
    expect(normalizeRfcMessageId('<abc123@gmail.com>')).toBe('abc123@gmail.com');
  });

  it('returns a bare id unchanged (some servers strip the brackets themselves)', () => {
    expect(normalizeRfcMessageId('abc123@gmail.com')).toBe('abc123@gmail.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRfcMessageId('  <abc@x.com>  ')).toBe('abc@x.com');
    expect(normalizeRfcMessageId('\n<abc@x.com>\t')).toBe('abc@x.com');
  });

  it('handles undefined / null / empty input by returning undefined', () => {
    expect(normalizeRfcMessageId(undefined)).toBeUndefined();
    expect(normalizeRfcMessageId(null)).toBeUndefined();
    expect(normalizeRfcMessageId('')).toBeUndefined();
  });

  it('treats brackets-only / whitespace-only input as no id', () => {
    expect(normalizeRfcMessageId('<>')).toBeUndefined();
    expect(normalizeRfcMessageId('   ')).toBeUndefined();
    expect(normalizeRfcMessageId('<   >')).toBeUndefined();
  });

  it("preserves the id even if it contains characters that look bracket-ish but aren't at the ends", () => {
    // Real-world Message-IDs occasionally embed <…> inside the id (rare but
    // legal). Make sure we only peel the OUTER pair, not anything inner.
    expect(normalizeRfcMessageId('<foo<bar>baz@host>')).toBe('foo<bar>baz@host');
  });

  it('strips only one leading < and one trailing > (not nested layers)', () => {
    // Defensive: a malformed double-wrapped id keeps its inner brackets.
    expect(normalizeRfcMessageId('<<abc@host>>')).toBe('<abc@host>');
  });

  it('cross-folder canonicalisation: same id with/without brackets dedups to the same value', () => {
    // This is the key invariant the partial unique index relies on. If a
    // message arrives once in INBOX as `<abc@x>` and once in [Gmail]/All
    // Mail as `abc@x`, both must normalise to the same string so the
    // (account_id, rfc_message_id) constraint catches the second insert.
    const fromInbox = normalizeRfcMessageId('<abc@x.com>');
    const fromAllMail = normalizeRfcMessageId('abc@x.com');
    const withTrailingSpace = normalizeRfcMessageId('<abc@x.com> ');
    expect(fromInbox).toBe(fromAllMail);
    expect(fromInbox).toBe(withTrailingSpace);
  });
});

/**
 * Header-block parser feeds `classifyDelivery`. It has to handle the three
 * shapes real IMAP servers return: CRLF endings, folded continuations
 * (line starts with whitespace), and the occasional bare LF. Empty / missing
 * input must be safe — some messages have none of the requested headers, in
 * which case ImapFlow returns an empty buffer.
 */
describe('parseHeaderBlock', () => {
  it('parses a simple CRLF header block', () => {
    const block = 'List-Unsubscribe: <mailto:u@example.com>\r\nPrecedence: bulk\r\n';
    expect(parseHeaderBlock(Buffer.from(block))).toEqual({
      'list-unsubscribe': '<mailto:u@example.com>',
      precedence: 'bulk',
    });
  });

  it('joins folded continuation lines into one value', () => {
    // RFC 5322 lets a header value wrap across lines as long as the
    // continuation starts with whitespace. List-Unsubscribe is a frequent
    // offender because two URLs often blow past 78 chars.
    const block = 'List-Unsubscribe: <mailto:u@example.com>,\r\n <https://example.com/u/abc>\r\n';
    expect(parseHeaderBlock(block)['list-unsubscribe']).toBe(
      '<mailto:u@example.com>, <https://example.com/u/abc>',
    );
  });

  it('lower-cases header names', () => {
    const block = 'X-MC-User: abc\r\nFEEDBACK-ID: xyz\r\n';
    const out = parseHeaderBlock(block);
    expect(out['x-mc-user']).toBe('abc');
    expect(out['feedback-id']).toBe('xyz');
  });

  it('keeps the first occurrence on repeat', () => {
    const block = 'Precedence: list\r\nPrecedence: bulk\r\n';
    expect(parseHeaderBlock(block)['precedence']).toBe('list');
  });

  it('handles bare LF line endings', () => {
    const block = 'List-ID: <x.list>\nPrecedence: list\n';
    expect(parseHeaderBlock(block)).toEqual({
      'list-id': '<x.list>',
      precedence: 'list',
    });
  });

  it('returns {} for empty / undefined / malformed input', () => {
    expect(parseHeaderBlock(undefined)).toEqual({});
    expect(parseHeaderBlock('')).toEqual({});
    expect(parseHeaderBlock(Buffer.alloc(0))).toEqual({});
    // No colon → not a header line; skipped, not thrown.
    expect(parseHeaderBlock('not a header\r\n')).toEqual({});
  });

  it('preserves empty values as empty strings (caller treats as absent)', () => {
    // Some malformed mail surfaces `List-ID:` with no value. We keep the
    // key but as an empty string so `classifyDelivery`'s "non-empty"
    // gate skips it.
    expect(parseHeaderBlock('List-ID: \r\n')).toEqual({ 'list-id': '' });
  });
});

import { describe, expect, it } from 'vitest';
import { classifyDelivery, type ClassifyInput } from './classify';

/**
 * Rule-cascade tests for classifyDelivery. The classifier is pure, so each
 * test constructs the exact input the IMAP provider will hand it after
 * parsing one message's headers (lower-cased keys, string values).
 *
 * Coverage is organised by output kind so a regression in one bucket lights
 * up a focused failure rather than a single sprawling table.
 */

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    headers: {},
    fromAddr: 'someone@example.com',
    labels: [],
    ...over,
  };
}

describe('classifyDelivery — marketing', () => {
  it('Mailchimp newsletter with one-click unsubscribe', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'list-unsubscribe': '<mailto:u@mailchimp.com>',
            'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
            'x-mc-user': 'abc123',
          },
          fromAddr: 'campaign@news.example.com',
        }),
      ),
    ).toBe('marketing');
  });

  it('Gmail CATEGORY_PROMOTIONS label is a hard positive', () => {
    expect(
      classifyDelivery(
        input({
          // No marketing headers at all — Gmail's classifier is the only
          // signal. We trust it for the promo bucket.
          labels: ['\\Inbox', 'CATEGORY_PROMOTIONS'],
          fromAddr: 'anything@example.com',
        }),
      ),
    ).toBe('marketing');
  });

  it('Precedence: bulk standalone', () => {
    expect(
      classifyDelivery(
        input({
          headers: { precedence: 'bulk' },
        }),
      ),
    ).toBe('marketing');
  });

  it('Feedback-ID present', () => {
    expect(
      classifyDelivery(
        input({
          headers: { 'feedback-id': '1.us-east-1.AbCdEfG.example' },
        }),
      ),
    ).toBe('marketing');
  });

  it('ESP fingerprint + List-Unsubscribe + no Auto-Submitted', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'x-ses-outgoing': '2026.05.26-1.2.3.4',
            'list-unsubscribe': '<https://unsub.example.com/x>',
          },
        }),
      ),
    ).toBe('marketing');
  });

  it('SendGrid send with one-click marker', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'x-sg-eid': 'abc',
            'list-unsubscribe': '<mailto:unsub@x>',
            'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
          },
        }),
      ),
    ).toBe('marketing');
  });

  it('Mailgun campaign', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'x-mailgun-sid': 'WyIzN…',
            'list-unsubscribe': '<https://x>',
          },
        }),
      ),
    ).toBe('marketing');
  });
});

describe('classifyDelivery — automated', () => {
  it('Stripe receipt via SendGrid (ESP + List-Unsubscribe + Auto-Submitted)', () => {
    // Even though it matches the ESP-fingerprint + List-Unsubscribe rule,
    // Auto-Submitted: auto-generated downgrades it from marketing to
    // automated — exactly the transactional-mail nuance the cascade exists
    // to capture.
    expect(
      classifyDelivery(
        input({
          headers: {
            'x-sg-eid': 'abc',
            'list-unsubscribe': '<mailto:unsub@stripe.com>',
            'auto-submitted': 'auto-generated',
          },
          fromAddr: 'receipts@stripe.com',
        }),
      ),
    ).toBe('automated');
  });

  it('GitHub notification with Auto-Submitted', () => {
    expect(
      classifyDelivery(
        input({
          headers: { 'auto-submitted': 'auto-generated' },
          fromAddr: 'notifications@github.com',
        }),
      ),
    ).toBe('automated');
  });

  it('Auto-Submitted: auto-replied', () => {
    expect(
      classifyDelivery(
        input({
          headers: { 'auto-submitted': 'auto-replied' },
        }),
      ),
    ).toBe('automated');
  });

  it('Precedence: auto_reply', () => {
    expect(
      classifyDelivery(
        input({
          headers: { precedence: 'auto_reply' },
        }),
      ),
    ).toBe('automated');
  });

  it('noreply@ local part (no other tells)', () => {
    expect(
      classifyDelivery(
        input({ fromAddr: 'noreply@vendor.example' }),
      ),
    ).toBe('automated');
  });

  it('no-reply@ local part with hyphen', () => {
    expect(
      classifyDelivery(
        input({ fromAddr: 'no-reply@vendor.example' }),
      ),
    ).toBe('automated');
  });

  it('notifications-pr-123@ local part matches notifications marker', () => {
    expect(
      classifyDelivery(
        input({ fromAddr: 'notifications-pr-123@github.com' }),
      ),
    ).toBe('automated');
  });

  it('postmaster@ local part', () => {
    expect(
      classifyDelivery(
        input({ fromAddr: 'postmaster@mail.example.com' }),
      ),
    ).toBe('automated');
  });

  it('residual List-Unsubscribe (transactional, no fingerprint)', () => {
    // A receipt sent from a custom MTA with List-Unsubscribe for
    // compliance — falls through marketing (no fingerprint, no bulk
    // marker), falls through list, falls through Auto-Submitted, and
    // lands here.
    expect(
      classifyDelivery(
        input({
          headers: { 'list-unsubscribe': '<mailto:unsub@bank.example>' },
          fromAddr: 'receipts@bank.example',
        }),
      ),
    ).toBe('automated');
  });

  it('Auto-Submitted: no does NOT trigger automated', () => {
    // Per RFC 3834, "no" is the explicit non-automated value. We must not
    // promote it.
    expect(
      classifyDelivery(
        input({
          headers: { 'auto-submitted': 'no' },
          fromAddr: 'human@example.com',
        }),
      ),
    ).toBe('direct');
  });
});

describe('classifyDelivery — list', () => {
  it('Google Group with List-ID', () => {
    expect(
      classifyDelivery(
        input({
          headers: { 'list-id': '<church-group.googlegroups.com>' },
          fromAddr: 'group-member@personal.example',
        }),
      ),
    ).toBe('list');
  });

  it('Precedence: list (no List-ID)', () => {
    expect(
      classifyDelivery(
        input({
          headers: { precedence: 'list' },
        }),
      ),
    ).toBe('list');
  });

  it('mailing list with both List-ID and Precedence: list', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'list-id': '<devs.list.example>',
            precedence: 'list',
          },
        }),
      ),
    ).toBe('list');
  });

  it('list dominates over residual List-Unsubscribe', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'list-id': '<x.list.example>',
            'list-unsubscribe': '<mailto:unsub@x>',
          },
        }),
      ),
    ).toBe('list');
  });
});

describe('classifyDelivery — direct', () => {
  it('human reply, no special headers', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            // Even a real Message-ID isn't a tell — direct mail has one too.
          },
          fromAddr: 'jason.friend@example.com',
        }),
      ),
    ).toBe('direct');
  });

  it('empty headers, empty labels', () => {
    expect(
      classifyDelivery({ headers: {}, fromAddr: 'someone@example.com', labels: [] }),
    ).toBe('direct');
  });

  it('"notify-me" is not a noreply marker (no separator after token)', () => {
    // The marker `notification` must be followed by a separator. "notify"
    // is a different token — and "notify-me" is a totally plausible human
    // address. Guard the heuristic against false positives.
    expect(
      classifyDelivery(input({ fromAddr: 'notify-me@example.com' })),
    ).toBe('direct');
  });

  it('Auto-Submitted: no explicitly does not promote', () => {
    expect(
      classifyDelivery(
        input({ headers: { 'auto-submitted': 'no' } }),
      ),
    ).toBe('direct');
  });
});

describe('classifyDelivery — robustness', () => {
  it('handles missing labels (undefined)', () => {
    expect(
      classifyDelivery({
        headers: {},
        fromAddr: 'person@example.com',
      }),
    ).toBe('direct');
  });

  it('handles empty header values gracefully', () => {
    // Some malformed mail surfaces `List-ID:` with an empty value. We
    // require a non-empty string to consider the header present, so this
    // should still classify as direct.
    expect(
      classifyDelivery(
        input({
          headers: { 'list-id': '' },
        }),
      ),
    ).toBe('direct');
  });

  it('Precedence value is whitespace-trimmed and lower-cased', () => {
    expect(
      classifyDelivery(
        input({
          headers: { precedence: '  BULK  ' },
        }),
      ),
    ).toBe('marketing');
  });

  it('case-insensitive label match for CATEGORY_PROMOTIONS', () => {
    expect(
      classifyDelivery(
        input({
          labels: ['category_promotions'],
        }),
      ),
    ).toBe('marketing');
  });

  it('marketing wins over list when both could match', () => {
    // RFC 8058 one-click + a list-id (rare but legal) — marketing comes
    // first in the cascade.
    expect(
      classifyDelivery(
        input({
          headers: {
            'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
            'list-id': '<news.example>',
          },
        }),
      ),
    ).toBe('marketing');
  });

  it('list wins over automated when both could match', () => {
    expect(
      classifyDelivery(
        input({
          headers: {
            'list-id': '<x.list.example>',
            'auto-submitted': 'auto-generated',
          },
        }),
      ),
    ).toBe('list');
  });
});

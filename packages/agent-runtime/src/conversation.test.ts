import { describe, expect, it } from 'vitest';
import { formatToolRecordSuffix, looksAnaphoricFollowup } from './conversation';

describe('looksAnaphoricFollowup', () => {
  it('flags short referential follow-ups (enrich the retrieval embedding)', () => {
    for (const q of [
      'tell me more about that',
      'what about it?',
      'continue',
      'the lister one',
      'how about those',
      'go on',
    ]) {
      expect(looksAnaphoricFollowup(q)).toBe(true);
    }
  });

  it('leaves clear standalone queries alone (no dilution)', () => {
    for (const q of [
      'my bank balance',
      'when does my car licence expire',
      'who does Cross Works bank with',
      'what is the capital of France', // long enough + no referent
      '',
    ]) {
      expect(looksAnaphoricFollowup(q)).toBe(false);
    }
  });

  it('requires BOTH short AND referential', () => {
    // referential but long → not treated as a bare follow-up
    expect(
      looksAnaphoricFollowup(
        'I was reading about that printer gantry rebuild plan in detail today',
      ),
    ).toBe(false);
    // short but no referent
    expect(looksAnaphoricFollowup('sermon notes')).toBe(false);
  });
});

describe('formatToolRecordSuffix', () => {
  it('is silent when there is nothing worth saying', () => {
    // rows predating the ledger, foreign data shapes, chat-only turns
    expect(formatToolRecordSuffix(null)).toBeNull();
    expect(formatToolRecordSuffix(undefined)).toBeNull();
    expect(formatToolRecordSuffix({})).toBeNull();
    expect(formatToolRecordSuffix({ thoughts: [] })).toBeNull();
    expect(formatToolRecordSuffix({ toolStats: 'garbage' })).toBeNull();
    // all-success read-only turn: no failures, no queued, no writes
    expect(
      formatToolRecordSuffix({
        toolStats: { calls: 4, succeeded: 4, failed: 0, skipped: 0, queued: 0, failures: [] },
      }),
    ).toBeNull();
  });

  it('reports failures with slug + snipped error', () => {
    const s = formatToolRecordSuffix({
      toolStats: {
        calls: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
        queued: 0,
        failures: [{ slug: 'telegram_send', error: 'x'.repeat(200) }],
      },
    });
    expect(s).toContain('[tool record: 3 tool calls ran; 1 FAILED: telegram_send (');
    expect(s!.length).toBeLessThan(200);
  });

  it('reports write targets so "where did you update it?" is answerable', () => {
    const s = formatToolRecordSuffix({
      toolStats: {
        calls: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        queued: 0,
        failures: [],
        writes: [
          {
            slug: 'table_create',
            id: '1964e026-9c95-4cae-9670-9908f6ad8f8e',
            title: 'Domain Records',
          },
          { slug: 'page_update', id: 'ca4ede98-f0c4-4286-85b3-33c978099468' },
        ],
      },
    });
    expect(s).toBe('[tool record: 2 tool calls ran; wrote: "Domain Records" (1964e026), ca4ede98]');
  });

  it('caps failure and write lists', () => {
    const writes = Array.from({ length: 5 }, (_, i) => ({
      slug: 'page_update',
      id: `0000000${i}-0000-4000-8000-000000000000`,
      title: `Page ${i}`,
    }));
    const failures = Array.from({ length: 5 }, (_, i) => ({ slug: `t${i}`, error: 'e' }));
    const s = formatToolRecordSuffix({
      toolStats: { calls: 10, succeeded: 5, failed: 5, skipped: 0, queued: 0, failures, writes },
    });
    expect(s).toContain('5 FAILED: t0 (e), t1 (e)');
    expect(s).toContain('+2 more');
    expect(s).not.toContain('Page 3');
  });

  it('reports queued-for-approval calls as not yet run', () => {
    const s = formatToolRecordSuffix({
      toolStats: { calls: 1, succeeded: 0, failed: 0, skipped: 1, queued: 1, failures: [] },
    });
    expect(s).toBe('[tool record: 1 tool call ran; 1 queued for operator approval, not yet run]');
  });
});

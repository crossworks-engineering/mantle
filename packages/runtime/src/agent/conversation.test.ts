import { describe, expect, it } from 'vitest';
import {
  formatMediaRecordSuffix,
  formatToolRecordSuffix,
  looksAnaphoricFollowup,
} from './conversation';
import { exchangeText, groupExchanges, withRecalledExchanges } from './conversation/select';

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

/**
 * Media read-back. The regression: an image generated on one turn was
 * unreferenceable on the next, because history replayed reply text and left the
 * `attachments` column behind. The model reconstructed a UUID from a display
 * prefix and wrote a page with a dangling image.
 */
describe('formatMediaRecordSuffix', () => {
  const IMG = '2153d1f2-c8ed-4bcf-bb76-b99b10f5c077';

  it('is silent for turns with no media, and for foreign shapes', () => {
    expect(formatMediaRecordSuffix([])).toBeNull();
    expect(formatMediaRecordSuffix(null)).toBeNull();
    expect(formatMediaRecordSuffix(undefined)).toBeNull();
    expect(formatMediaRecordSuffix({ kind: 'image' })).toBeNull();
    expect(formatMediaRecordSuffix([null, 'x', 7])).toBeNull();
  });

  it('quotes the full node id, so the next turn never rebuilds one', () => {
    const out = formatMediaRecordSuffix([
      { kind: 'image', nodeId: IMG, caption: 'A beautiful house surrounded by flowers' },
    ]);
    expect(out).toBe(
      '[media record: image "A beautiful house surrounded by flowers" = ' +
        `media:${IMG} — reference these by the id shown, copied whole]`,
    );
  });

  it('skips a transport-only handle, which media: cannot resolve', () => {
    expect(formatMediaRecordSuffix([{ kind: 'image', fileId: 'AgACAgQAAx' }])).toBeNull();
  });

  it('handles a missing caption', () => {
    expect(formatMediaRecordSuffix([{ kind: 'audio', nodeId: IMG }])).toContain(
      `audio = media:${IMG}`,
    );
  });

  it('snips a long caption but never the id', () => {
    const out = formatMediaRecordSuffix([{ kind: 'image', nodeId: IMG, caption: 'x'.repeat(200) }]);
    expect(out).toContain('…');
    expect(out).toContain(`media:${IMG}`);
    expect(out!.length).toBeLessThan(200);
  });

  it('caps the list and says how many it dropped', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      kind: 'image',
      nodeId: `${i}153d1f2-c8ed-4bcf-bb76-b99b10f5c077`,
    }));
    const out = formatMediaRecordSuffix(many);
    expect(out).toContain('+2 more');
    expect(out).toContain('0153d1f2');
    expect(out).not.toContain('4153d1f2');
  });
});

describe('history_recall helpers', () => {
  const u = (text: string) => ({ role: 'user' as const, text });
  const a = (text: string) => ({ role: 'assistant' as const, text });

  it('groups turns into exchanges; a leading reply is its own exchange', () => {
    const g = groupExchanges([a('orphan'), u('q1'), a('r1'), u('q2'), u('q3'), a('r3')]);
    expect(g.map((x) => x.start)).toEqual([0, 1, 3, 4]);
    expect(g[1]!.turns).toEqual([u('q1'), a('r1')]);
    expect(exchangeText(g[1]!.turns)).toBe('USER: q1\nASSISTANT: r1');
  });

  it('puts recalled exchanges (time order) before the recent part, marking each first turn', () => {
    const out = withRecalledExchanges(
      [u('recent q'), a('recent r')],
      [
        { turns: [u('older q')], back: 44 },
        { turns: [u('old q'), a('old r')], back: 31 },
      ],
    );
    expect(out.map((t) => t.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
    expect(out[0]!.text).toMatch(
      /^\[Recalled from earlier in this conversation, 44 messages back[\s\S]*\nolder q$/,
    );
    expect(out[1]!.text).toMatch(/31 messages back[\s\S]*\nold q$/);
    expect(out[2]!.text).toBe('old r');
    expect(out.slice(3)).toEqual([u('recent q'), a('recent r')]);
  });
});

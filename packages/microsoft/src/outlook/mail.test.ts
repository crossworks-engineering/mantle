import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailAccount } from '@mantle/db';

/**
 * Graph → RawMessage normalization + the sync watermark, the two places a
 * malformed Graph response or an off-by-one cursor would silently corrupt the
 * mail feed. We mock only the HTTP seam (../client.graphGet) and drive the real
 * provider; classifyDelivery runs for real (it's pure).
 *
 * What's pinned:
 *   - address/name extraction, from→sender fallback, header lowercasing,
 *     flag→isStarred, categories→labels, missing receivedDateTime → a Date;
 *   - the cursor advances to EACH message's own receivedDateTime and the filter
 *     uses `ge` (not `gt`) so the boundary message is re-yielded, never skipped;
 *   - paging follows @odata.nextLink;
 *   - fetchFull decodes base64 file attachments and ignores item attachments.
 */

const graphGet = vi.fn();
vi.mock('../client', () => ({ graphGet: (...a: unknown[]) => graphGet(...a) }));

import { graphMailProvider } from './mail';

const account = {
  id: 'acc-1',
  userId: 'user-1',
  msAccountId: 'ms-1',
  firstScanDays: 365,
} as EmailAccount;

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'graph-id-1',
    internetMessageId: '<abc@ex.com>',
    conversationId: 'conv-1',
    subject: 'Hello',
    bodyPreview: 'preview text',
    from: { emailAddress: { name: 'Alice', address: 'Alice@Ex.com' } },
    toRecipients: [{ emailAddress: { address: 'ME@Ex.com' } }],
    receivedDateTime: '2026-01-05T10:00:00Z',
    isRead: true,
    hasAttachments: false,
    ...overrides,
  };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

/** Element `i`, narrowed (throws if absent) — keeps noUncheckedIndexedAccess happy. */
function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element ${i}`);
  return v;
}
const first = <T>(arr: T[]): T => nth(arr, 0);
const sinceOf = (raw: unknown) => (raw as { graph: { mail: { since: string } } }).graph.mail.since;

beforeEach(() => graphGet.mockReset());
afterEach(() => vi.clearAllMocks());

describe('graphMailProvider.listSince — normalization', () => {
  it('normalizes a Graph message, lowercasing addresses and stripping angle brackets from the rfc id', async () => {
    graphGet.mockResolvedValueOnce({ value: [msg()] });
    const { message } = first(await collect(graphMailProvider.listSince(account, undefined)));

    expect(message.providerMsgId).toBe('graph-id-1');
    expect(message.rfcMessageId).toBe('abc@ex.com');
    expect(message.threadId).toBe('conv-1');
    expect(message.fromAddr).toBe('alice@ex.com');
    expect(message.fromName).toBe('Alice');
    expect(message.toAddrs).toEqual(['me@ex.com']);
    expect(message.folder).toBe('Inbox');
    expect(message.isRead).toBe(true);
  });

  it('falls back to sender when from is absent', async () => {
    graphGet.mockResolvedValueOnce({
      value: [msg({ from: undefined, sender: { emailAddress: { address: 'Bounce@Ex.com' } } })],
    });
    const { message } = first(await collect(graphMailProvider.listSince(account, undefined)));
    expect(message.fromAddr).toBe('bounce@ex.com');
  });

  it('maps flag→isStarred and categories→labels', async () => {
    graphGet.mockResolvedValueOnce({
      value: [msg({ flag: { flagStatus: 'flagged' }, categories: ['Blue category'] })],
    });
    const { message } = first(await collect(graphMailProvider.listSince(account, undefined)));
    expect(message.isStarred).toBe(true);
    expect(message.labels).toEqual(['Blue category']);
  });

  it('substitutes a real Date when receivedDateTime is missing (never NaN/undefined)', async () => {
    graphGet.mockResolvedValueOnce({ value: [msg({ receivedDateTime: undefined })] });
    const { message } = first(await collect(graphMailProvider.listSince(account, undefined)));
    expect(message.internalDate).toBeInstanceOf(Date);
    expect(Number.isNaN(message.internalDate.getTime())).toBe(false);
  });
});

describe('graphMailProvider.listSince — cursor watermark', () => {
  it('advances the cursor to each message own receivedDateTime (not a batch max)', async () => {
    graphGet.mockResolvedValueOnce({
      value: [
        msg({ id: 'm1', receivedDateTime: '2026-01-01T00:00:00Z' }),
        msg({ id: 'm2', receivedDateTime: '2026-01-02T00:00:00Z' }),
      ],
    });
    const yields = await collect(graphMailProvider.listSince(account, undefined));
    expect(sinceOf(nth(yields, 0).nextCursor.raw)).toBe('2026-01-01T00:00:00Z');
    expect(sinceOf(nth(yields, 1).nextCursor.raw)).toBe('2026-01-02T00:00:00Z');
  });

  it('resumes from the stored cursor using a `ge` filter so the boundary message is re-yielded, not skipped', async () => {
    graphGet.mockResolvedValueOnce({ value: [] });
    const cursor = { raw: { graph: { mail: { since: '2026-03-01T12:00:00Z' } } } };
    await collect(graphMailProvider.listSince(account, cursor));

    const url = nth(first(graphGet.mock.calls), 2) as string;
    expect(url).toContain(encodeURIComponent('receivedDateTime ge 2026-03-01T12:00:00Z'));
    expect(url).not.toContain(encodeURIComponent('gt '));
  });

  it('first scan (no cursor) reaches back firstScanDays', async () => {
    graphGet.mockResolvedValueOnce({ value: [] });
    const acc = { ...account, firstScanDays: 30 } as EmailAccount;
    const before = Date.now();
    await collect(graphMailProvider.listSince(acc, undefined));
    const url = decodeURIComponent(nth(first(graphGet.mock.calls), 2) as string);
    const iso = url.match(/receivedDateTime ge (\S+)/)?.[1];
    if (!iso) throw new Error('no since in url');
    const since = new Date(iso).getTime();
    const days = (before - since) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('follows @odata.nextLink across pages', async () => {
    graphGet
      .mockResolvedValueOnce({
        value: [msg({ id: 'm1' })],
        '@odata.nextLink': 'https://graph/next',
      })
      .mockResolvedValueOnce({ value: [msg({ id: 'm2' })] });
    const yields = await collect(graphMailProvider.listSince(account, undefined));
    expect(yields.map((y) => y.message.providerMsgId)).toEqual(['m1', 'm2']);
    expect(nth(nth(graphGet.mock.calls, 1), 2)).toBe('https://graph/next');
  });

  it('throws when the account is missing ms_account_id (never silently syncs the wrong mailbox)', async () => {
    const bad = { ...account, msAccountId: null } as unknown as EmailAccount;
    await expect(collect(graphMailProvider.listSince(bad, undefined))).rejects.toThrow(
      /ms_account_id/,
    );
  });
});

describe('graphMailProvider.fetchFull', () => {
  it('decodes base64 file attachments and skips non-file (item) attachments', async () => {
    graphGet
      .mockResolvedValueOnce({
        body: { contentType: 'html', content: '<p>hi</p>' },
        hasAttachments: true,
      })
      .mockResolvedValueOnce({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'att-1',
            name: 'doc.pdf',
            contentType: 'application/pdf',
            size: 3,
            contentBytes: Buffer.from('abc').toString('base64'),
          },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att-2', name: 'nested' },
        ],
      });

    const full = await graphMailProvider.fetchFull(account, 'graph-id-1');
    expect(full.bodyHtml).toBe('<p>hi</p>');
    expect(full.bodyText).toBeUndefined();
    expect(full.attachments).toHaveLength(1);
    const att = first(full.attachments);
    expect(att.filename).toBe('doc.pdf');
    expect(att.content.toString()).toBe('abc');
  });

  it('treats a text/plain body as bodyText, not bodyHtml', async () => {
    graphGet.mockResolvedValueOnce({
      body: { contentType: 'text', content: 'plain body' },
      hasAttachments: false,
    });
    const full = await graphMailProvider.fetchFull(account, 'graph-id-1');
    expect(full.bodyText).toBe('plain body');
    expect(full.bodyHtml).toBeUndefined();
    // hasAttachments false → no second Graph call for /attachments.
    expect(graphGet).toHaveBeenCalledTimes(1);
  });
});

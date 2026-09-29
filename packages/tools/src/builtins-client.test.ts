/**
 * The client tools (client logins C4) without a database: who they serve
 * (a client surface only), what they read (the portal's redacted items, at
 * client level), how the search matches (the text the CLIENT sees, never the
 * raw text), and the request's provenance and caps.
 * The row-security side runs on Postgres in builtins-client.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const PAGE = '44444444-4444-4444-8444-444444444444';
const NOTE = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  levels: [] as string[],
  filed: [] as Record<string, unknown>[],
  counts: { turn: 0, day: 0 },
  systemCalls: 0,
  ledger: [] as Record<string, unknown>[],
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withViewer: async (level: string, fn: () => Promise<unknown>) => {
    h.levels.push(level);
    return fn();
  },
}));

vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  asSystem: async (fn: () => Promise<unknown>) => {
    h.systemCalls++;
    return fn();
  },
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listClientShared: vi.fn(async () => ({
    items: [
      { id: PAGE, type: 'page', title: 'Shutdown plan', icon: null, updatedAt: '2026-09-01' },
      { id: NOTE, type: 'note', title: 'Weekly note', icon: null, updatedAt: '2026-09-02' },
    ],
    total: 2,
  })),
  getClientSharedItem: vi.fn(async (_owner: string, id: string) => {
    if (id === PAGE) {
      // The redacted doc: the mention of a team item reads "Private item".
      return {
        id: PAGE,
        type: 'page',
        title: 'Shutdown plan',
        icon: null,
        updatedAt: '2026-09-01',
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'The unit restarts on 12 October. See ' },
                { type: 'mention', attrs: { id: null, label: 'Private item' } },
              ],
            },
          ],
        },
      };
    }
    if (id === NOTE) {
      return {
        id: NOTE,
        type: 'note',
        title: 'Weekly note',
        icon: null,
        updatedAt: '2026-09-02',
        content: 'Crane booked for the turnaround.',
      };
    }
    return null;
  }),
  // The caps count the filing ledger (C5 audit fix I12), not the live tasks.
  countClientRequestFilings: vi.fn(async (_o: string, by: Record<string, unknown>) =>
    'threadMessageId' in by ? h.counts.turn : h.counts.day,
  ),
  countTeamRequestsFiled: vi.fn(async () => {
    throw new Error('client caps must not count the live tasks');
  }),
  recordClientRequestFiling: vi.fn(async (_o: string, row: Record<string, unknown>) => {
    h.ledger.push(row);
  }),
  createTask: vi.fn(async (_o: string, input: Record<string, unknown>) => {
    h.filed.push(input);
    return { id: '77777777-7777-4777-8777-777777777777', title: input.title };
  }),
}));

const clientCtx = (extra: Record<string, unknown> = {}) => ({
  ownerId: OWNER,
  surface: { kind: 'client' as const, loginId: LOGIN, contactName: 'Casey', ...extra },
});

beforeEach(() => {
  h.levels = [];
  h.filed = [];
  h.counts = { turn: 0, day: 0 };
  h.systemCalls = 0;
  h.ledger = [];
});

describe('client tools serve a client surface only', () => {
  const others = [
    undefined,
    { kind: 'web' as const },
    { kind: 'telegram' as const, telegramChatId: '1' },
    { kind: 'owner' as const, via: 'mcp' as const },
    { kind: 'team' as const, loginId: LOGIN },
  ];
  it('every client tool refuses every other surface, before reading anything', async () => {
    const { CLIENT_TOOLS } = await import('./builtins-client');
    const content = await import('@mantle/content');
    for (const tool of CLIENT_TOOLS) {
      for (const surface of others) {
        const res = await tool.handler({ id: PAGE, q: 'shutdown', title: 't', body: 'b' }, {
          ownerId: OWNER,
          ...(surface ? { surface } : {}),
        } as never);
        expect(res.ok, `${tool.slug} on ${surface?.kind ?? 'no surface'}`).toBe(false);
      }
    }
    expect(vi.mocked(content.listClientShared)).not.toHaveBeenCalled();
    expect(vi.mocked(content.getClientSharedItem)).not.toHaveBeenCalled();
    expect(h.filed).toEqual([]);
  });
});

describe('client_shared_list / _open read at client level, as the portal shows it', () => {
  it('list runs inside withViewer(client) and returns portal rows with a portal link', async () => {
    const { client_shared_list } = await import('./builtins-client');
    const res = await client_shared_list.handler({}, clientCtx() as never);
    expect(h.levels).toEqual(['client']);
    expect(res).toMatchObject({
      ok: true,
      output: {
        items: [
          { id: PAGE, title: 'Shutdown plan', link: `/n/${PAGE}` },
          { id: NOTE, title: 'Weekly note', link: `/n/${NOTE}` },
        ],
        total: 2,
      },
    });
  });

  it("open returns the redacted text: a team item's reference reads Private item", async () => {
    const { client_shared_open } = await import('./builtins-client');
    const res = await client_shared_open.handler({ id: PAGE }, clientCtx() as never);
    expect(h.levels).toEqual(['client']);
    expect(res.ok).toBe(true);
    const out = (res as { output: { text: string } }).output;
    expect(out.text).toContain('The unit restarts on 12 October.');
    expect(out.text).toContain('Private item');
  });

  it('open of an item the client may not read is "not found" (no hint it exists)', async () => {
    const { client_shared_open } = await import('./builtins-client');
    const res = await client_shared_open.handler(
      { id: '99999999-9999-4999-8999-999999999999' },
      clientCtx() as never,
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/not found among the items shared/);
  });
});

describe('client_shared_search matches what the client sees', () => {
  it('finds a word in the redacted body, with a passage', async () => {
    const { client_shared_search } = await import('./builtins-client');
    const res = await client_shared_search.handler({ q: 'restarts' }, clientCtx() as never);
    const hits = (res as { output: { hits: { id: string; passage: string }[] } }).output.hits;
    expect(hits.map((x) => x.id)).toEqual([PAGE]);
    expect(hits[0]!.passage).toContain('restarts');
  });

  it('a word only a Private item carries finds nothing (the search reads no raw text)', async () => {
    const { client_shared_search } = await import('./builtins-client');
    // "Falcon" is nowhere in what the client reads (the page's team mention
    // is redacted before the match): no hit.
    const res = await client_shared_search.handler({ q: 'Falcon' }, clientCtx() as never);
    expect((res as { output: { hits: unknown[] } }).output.hits).toEqual([]);
  });

  it('searchTerms and snippetAround', async () => {
    const { searchTerms, snippetAround } = await import('./builtins-client');
    expect(searchTerms('The  Shutdown, date? a')).toEqual(['the', 'shutdown', 'date']);
    expect(snippetAround('x'.repeat(300) + ' target here', ['target'])).toContain('target here');
  });
});

describe('client_request_create', () => {
  it('files a client-sourced team request with server-stamped provenance', async () => {
    const { client_request_create } = await import('./builtins-client');
    const res = await client_request_create.handler(
      // The model tries to forge who asks: ignored.
      { title: 'Send the revised schedule', body: 'Please.', loginId: 'forged' },
      clientCtx({ inboundMessageId: 'msg-1' }) as never,
    );
    expect(res.ok).toBe(true);
    expect(h.filed).toHaveLength(1);
    const task = h.filed[0]!;
    expect(task.tags).toEqual(['team-request', 'client-request']);
    expect(task.body).toMatch(/^\*\*Client request from Casey\.\*\*/);
    expect(task.extraData).toMatchObject({
      source: 'client-request',
      teamRequest: { loginId: LOGIN, requesterRole: 'client', threadMessageId: 'msg-1' },
    });
    // Written and counted on the admin pool (the client role never writes).
    expect(h.systemCalls).toBeGreaterThanOrEqual(2);
    // And recorded in the ledger the caps count.
    expect(h.ledger).toEqual([
      { loginId: LOGIN, threadMessageId: 'msg-1', taskId: '77777777-7777-4777-8777-777777777777' },
    ]);
  });

  it('3 per message and 10 a day', async () => {
    const { client_request_create } = await import('./builtins-client');
    h.counts.turn = 3;
    const perTurn = await client_request_create.handler(
      { title: 't', body: 'b' },
      clientCtx({ inboundMessageId: 'msg-1' }) as never,
    );
    expect((perTurn as { error: string }).error).toMatch(/3 requests per message/);
    h.counts.turn = 0;
    h.counts.day = 10;
    const perDay = await client_request_create.handler(
      { title: 't', body: 'b' },
      clientCtx({ inboundMessageId: 'msg-2' }) as never,
    );
    expect((perDay as { error: string }).error).toMatch(/10 requests in 24 hours/);
    expect(h.filed).toEqual([]);
    expect(h.ledger).toEqual([]);
  });
});

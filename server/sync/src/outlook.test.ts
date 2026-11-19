/**
 * An Outlook run over many folders (sync-complete audit round 1): every
 * chosen folder is read each run, however many there are; the watermark is
 * lastModifiedDateTime, so mail moved into a folder is seen; one message
 * Microsoft fails on, run after run, ends as a stub and never holds the
 * mailbox; a reference attachment's link is read on Graph's beta endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Msg = { id: string; from: string; at: string };
const graph = {
  folders: [] as { id: string; displayName: string }[],
  /** Messages per folder id. */
  messages: new Map<string, Msg[]>(),
  /** Message ids whose body read fails (a Graph 503). */
  broken: new Set<string>(),
  /** Message ids with one reference attachment (a OneDrive link). */
  withRef: new Set<string>(),
  urls: [] as string[],
};

vi.mock('./microsoft', async (orig) => {
  const real = await orig<typeof import('./microsoft')>();
  const json = async (_token: string, url: string): Promise<unknown> => {
    graph.urls.push(url);
    const u = new URL(url.startsWith('https://') ? url : `https://graph.microsoft.com/v1.0${url}`);
    if (u.pathname.endsWith('/mailFolders')) return { value: graph.folders };
    if (/\/mailFolders\/[a-z]+$/.test(u.pathname)) throw new real.GraphError(404, 'none');
    const inFolder = /\/mailFolders\/([^/]+)\/messages$/.exec(u.pathname);
    if (inFolder) {
      const id = decodeURIComponent(inFolder[1]!);
      const skip = Number(u.searchParams.get('$skip') ?? 0);
      // Graph's filter on the watermark and its sort (key paging asks again).
      const ge = /lastModifiedDateTime ge (\S+)/.exec(u.searchParams.get('$filter') ?? '')?.[1];
      const all = (graph.messages.get(id) ?? [])
        .filter((m) => !ge || m.at >= ge)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const page = all.slice(skip, skip + 50);
      const next =
        skip + 50 < all.length
          ? `https://graph.microsoft.com/v1.0${u.pathname}?${new URLSearchParams({
              ...Object.fromEntries(u.searchParams),
              $skip: String(skip + 50),
            })}`
          : undefined;
      return {
        value: page.map((m) => ({
          id: m.id,
          from: { emailAddress: { address: m.from } },
          receivedDateTime: m.at,
          lastModifiedDateTime: m.at,
          hasAttachments: graph.withRef.has(m.id),
        })),
        ...(next ? { '@odata.nextLink': next } : {}),
      };
    }
    if (/\/attachments$/.test(u.pathname))
      return {
        value: [{ '@odata.type': '#microsoft.graph.referenceAttachment', id: 'r1', name: 'Plan' }],
      };
    if (/\/attachments\/r1$/.test(u.pathname)) return {};
    const msg = /\/me\/messages\/([^/]+)$/.exec(u.pathname);
    if (msg) {
      const id = decodeURIComponent(msg[1]!);
      // A message's own listing (a retry reads it again by id).
      if ((u.searchParams.get('$select') ?? '').includes('internetMessageId')) {
        const found = [...graph.messages.values()].flat().find((m) => m.id === id);
        if (!found) throw new real.GraphError(404, 'gone');
        return {
          id,
          from: { emailAddress: { address: found.from } },
          receivedDateTime: found.at,
          lastModifiedDateTime: found.at,
        };
      }
      if (graph.broken.has(id)) throw new real.GraphError(503, 'Microsoft Graph answered 503');
      return { body: { contentType: 'text', content: `body of ${id}` } };
    }
    throw new Error(`unexpected Graph call ${url}`);
  };
  return {
    ...real,
    accessToken: async () => 'token',
    graphJson: json,
    graphAll: async (token: string, path: string) =>
      ((await json(token, path)) as { value: unknown[] }).value,
  };
});

const { syncOutlook, RUN_PAGES } = await import('./outlook');
const { failuresFor, MESSAGE_GIVE_UP_MS } = await import('./mail-stream');
const { BrainError } = await import('./brain');
type State = import('./state').State;
type MsAccount = import('./state').MsAccount;

const account = {
  id: 'acc',
  mailboxId: 'box',
  firstScanDays: 30,
  excludedFolders: [],
} as unknown as MsAccount;

function fakeState() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    state: {
      msCursor: async () => (kv.get('cursor') as never) ?? { since: null },
      putMsCursor: async (_: string, c: unknown) => void kv.set('cursor', c),
      msgFails: async () => ({ ...((kv.get('fails') as Record<string, number>) ?? {}) }),
      putMsgFails: async (_: string, f: unknown) => void kv.set('fails', f),
    } as unknown as State,
  };
}

const recent = (i: number) => new Date(Date.now() - 86_400_000 + i * 1000).toISOString();

beforeEach(() => {
  graph.folders = [];
  graph.messages = new Map();
  graph.broken = new Set();
  graph.withRef = new Set();
  graph.urls = [];
});

describe('an Outlook run over many folders', () => {
  it('reads every folder each run, past RUN_PAGES of them', async () => {
    const n = RUN_PAGES + 30;
    graph.folders = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, displayName: `F${i}` }));
    // The first folder has a long backlog; every other one mail of its own.
    graph.messages.set(
      'f0',
      Array.from({ length: 50 * 200 }, (_, i) => ({
        id: `f0-${i}`,
        from: 'a@b.test',
        at: recent(i),
      })),
    );
    for (let i = 1; i < n; i++)
      graph.messages.set(`f${i}`, [{ id: `f${i}-0`, from: 'a@b.test', at: recent(i) }]);
    const posted: string[] = [];
    const { state, kv } = fakeState();
    await syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId),
      async (m) => void posted.push(m.providerMsgId),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
    );
    for (let i = 1; i < n; i++) expect(posted).toContain(`f${i}-0`);
    const marks = (kv.get('cursor') as { folders: Record<string, string> }).folders;
    expect(Object.keys(marks)).toHaveLength(n);
    // The backlog went on, within the run's pages.
    expect(posted.filter((p) => p.startsWith('f0-')).length).toBeLessThanOrEqual(
      50 * (RUN_PAGES + 1),
    );
  });

  it('reads on lastModifiedDateTime, within the first-scan reach', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    const { state } = fakeState();
    await syncOutlook(
      state,
      account,
      async () => [],
      async () => {},
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
    );
    const list = graph.urls.find((u) => u.includes('/mailFolders/f0/messages'))!;
    const q = new URL(`https://graph.microsoft.com/v1.0${list}`).searchParams;
    expect(q.get('$orderby')).toBe('lastModifiedDateTime asc');
    expect(q.get('$filter')).toMatch(/^lastModifiedDateTime ge .* and receivedDateTime ge /);
  });
});

describe('a message Microsoft fails on', () => {
  let clock = Date.now();
  const run = async (state: State, posted: { id: string; body?: string }[]) =>
    syncOutlook(
      state,
      account,
      // The gate's dedup: what is stored already is not wanted again.
      async (envs) =>
        envs.map((e) => e.providerMsgId).filter((id) => !posted.some((p) => p.id === id)),
      async (m) => void posted.push({ id: m.providerMsgId, body: m.bodyText }),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      failuresFor(state, 'box', () => clock),
    );

  it('never holds the folder: the run goes on past it and tries it again', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [
      { id: 'bad', from: 'a@b.test', at: recent(1) },
      { id: 'good', from: 'a@b.test', at: recent(2) },
    ]);
    graph.broken.add('bad');
    const { state, kv } = fakeState();
    const posted: { id: string; body?: string }[] = [];
    await run(state, posted);
    expect(posted.map((p) => p.id)).toEqual(['good']);
    expect(Object.keys(kv.get('fails') as object)).toEqual(['bad']);
    // It reads once Microsoft hands it out: stored whole, forgotten.
    graph.broken.delete('bad');
    await run(state, posted);
    expect(posted.map((p) => p.id)).toEqual(['good', 'bad']);
    expect(posted[1]!.body).toBe('body of bad');
    expect(kv.get('fails')).toEqual({});
  });

  it('is a stub only after three tries over a day, never for a short outage', async () => {
    clock = Date.now();
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'bad', from: 'a@b.test', at: recent(1) }]);
    graph.broken.add('bad');
    const { state } = fakeState();
    const posted: { id: string; body?: string }[] = [];
    for (let i = 0; i < 5; i++) await run(state, posted);
    expect(posted).toEqual([]);
    clock += MESSAGE_GIVE_UP_MS + 1;
    await run(state, posted);
    expect(posted.map((p) => p.id)).toEqual(['bad']);
    expect(posted[0]!.body).toContain('could not be read');
  });

  it('never stubs or skips a message for the brain failing', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'm', from: 'a@b.test', at: recent(1) }]);
    const { state, kv } = fakeState();
    const fails = async () => {
      throw new BrainError(500, 'storage failed');
    };
    for (let i = 0; i < 4; i++) {
      await expect(
        syncOutlook(
          state,
          account,
          async (envs) => envs.map((e) => e.providerMsgId),
          fails,
          async () => ({ sha256: 'a'.repeat(64), size: 0 }),
          failuresFor(state, 'box'),
        ),
      ).rejects.toThrow('storage failed');
    }
    expect(kv.get('fails')).toBeUndefined();
  });
});

describe('paging by key', () => {
  it('skips nothing when messages change while the run reads', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      from: 'a@b.test',
      at: recent(i),
    }));
    graph.messages.set('f0', msgs);
    const posted: string[] = [];
    const { state } = fakeState();
    await syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId),
      async (m) => {
        posted.push(m.providerMsgId);
        // Someone reads the first message while the run goes on: it moves
        // to the end of the order.
        if (m.providerMsgId === 'm10') msgs[0]!.at = recent(500);
      },
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
    );
    for (let i = 0; i < 200; i++) expect(posted).toContain(`m${i}`);
  });

  it('crosses a group of messages changed in one second, past a page', async () => {
    graph.folders = [
      { id: 'f0', displayName: 'Inbox' },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `g${i}`, displayName: `G${i}` })),
    ];
    const t = recent(5);
    graph.messages.set('f0', [
      ...Array.from({ length: 400 }, (_, i) => ({ id: `tie${i}`, from: 'a@b.test', at: t })),
      { id: 'after', from: 'a@b.test', at: recent(9) },
    ]);
    // Other folders with backlogs of their own.
    for (let i = 0; i < 60; i++)
      graph.messages.set(
        `g${i}`,
        Array.from({ length: 120 }, (_, k) => ({
          id: `g${i}-${k}`,
          from: 'a@b.test',
          at: recent(k),
        })),
      );
    const posted: string[] = [];
    const { state } = fakeState();
    await syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId),
      async (m) => void posted.push(m.providerMsgId),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
    );
    expect(posted).toContain('after');
    expect(posted.filter((p) => p.startsWith('tie'))).toHaveLength(400);
  });
});

describe('a reference attachment', () => {
  it("reads its link on Graph's beta endpoint", async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'm', from: 'a@b.test', at: recent(1) }]);
    graph.withRef.add('m');
    const { state } = fakeState();
    const posted: { body?: string }[] = [];
    await syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId),
      async (m) => void posted.push({ body: m.bodyText }),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
    );
    expect(graph.urls).toContain('https://graph.microsoft.com/beta/me/messages/m/attachments/r1');
    expect(posted[0]!.body).toContain('the linked file "Plan" (no link given)');
  });
});

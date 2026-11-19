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
      const all = graph.messages.get(id) ?? [];
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
const { tolerateFor } = await import('./mail-stream');
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
  const run = async (state: State, posted: { id: string; body?: string }[]) =>
    syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId),
      async (m) => void posted.push({ id: m.providerMsgId, body: m.bodyText }),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      tolerateFor(state, 'box'),
    );

  it('fails the run twice, then is a stub with a note, and the folder goes on', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [
      { id: 'bad', from: 'a@b.test', at: recent(1) },
      { id: 'good', from: 'a@b.test', at: recent(2) },
    ]);
    graph.broken.add('bad');
    const { state } = fakeState();
    const posted: { id: string; body?: string }[] = [];
    await expect(run(state, posted)).rejects.toThrow(/503/);
    await expect(run(state, posted)).rejects.toThrow(/503/);
    await run(state, posted);
    expect(posted.map((p) => p.id)).toEqual(['bad', 'good']);
    expect(posted[0]!.body).toContain('could not be read');
  });

  it('never stubs a message for the brain failing', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'm', from: 'a@b.test', at: recent(1) }]);
    const { state } = fakeState();
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
          tolerateFor(state, 'box'),
        ),
      ).rejects.toThrow('storage failed');
    }
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

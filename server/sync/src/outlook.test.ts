/**
 * An Outlook run over many folders (sync-complete audit round 1): every
 * chosen folder is read each run, however many there are; the watermark is
 * lastModifiedDateTime, so mail moved into a folder is seen; one message
 * Microsoft fails on, run after run, ends as a stub and never holds the
 * mailbox; a reference attachment's link is read on Graph's beta endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A message: `at` its lastModifiedDateTime, `rec` its receivedDateTime
 *  (`at` when unset). */
type Msg = { id: string; from: string; at: string; rec?: string };
const graph = {
  folders: [] as { id: string; displayName: string }[],
  /** Messages per folder id. */
  messages: new Map<string, Msg[]>(),
  /** Message ids whose body read fails (a Graph 503). */
  broken: new Set<string>(),
  /** Message ids with one reference attachment (a OneDrive link). */
  withRef: new Set<string>(),
  /** Message ids whose body read times out (the call's own deadline). */
  slow: new Set<string>(),
  /** The network is down: every call but a folder listing fails. */
  down: false,
  /** Message ids with one file attachment whose bytes time out. */
  slowAtt: new Set<string>(),
  urls: [] as string[],
};

/** A time as Graph prints it: to the second. */
const toSecond = (iso: string) =>
  new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString().replace('.000Z', 'Z');

vi.mock('./microsoft', async (orig) => {
  const real = await orig<typeof import('./microsoft')>();
  const json = async (_token: string, url: string): Promise<unknown> => {
    graph.urls.push(url);
    const u = new URL(url.startsWith('https://') ? url : `https://graph.microsoft.com/v1.0${url}`);
    if (u.pathname.endsWith('/mailFolders')) return { value: graph.folders };
    if (graph.down && !/\/mailFolders\/[^/]+\/messages$/.test(u.pathname))
      throw new TypeError('fetch failed');
    if (u.pathname.endsWith('/mailFolders/inbox')) return { id: 'inbox-id' };
    if (/\/mailFolders\/[a-z]+$/.test(u.pathname)) throw new real.GraphError(404, 'none');
    const inFolder = /\/mailFolders\/([^/]+)\/messages$/.exec(u.pathname);
    if (inFolder) {
      const id = decodeURIComponent(inFolder[1]!);
      const skip = Number(u.searchParams.get('$skip') ?? 0);
      // Graph's filter on the watermark (ge, gt, eq), the received
      // reach, and its sort on both keys (key paging asks again).
      // Times are kept finer than they print (as Exchange may): a filter
      // compares the stored time, a reply prints it to the second.
      const filter = u.searchParams.get('$filter') ?? '';
      const ms = (v: string) => Date.parse(v);
      const mods = [...filter.matchAll(/lastModifiedDateTime (ge|gt|lt|eq) (\S+)/g)];
      const recGe = /receivedDateTime ge (\S+)/.exec(filter)?.[1];
      const byReceived = (u.searchParams.get('$orderby') ?? '').startsWith('receivedDateTime');
      const cmp = (a: number, b: number) => a - b;
      const all = (graph.messages.get(id) ?? [])
        .filter((m) => {
          for (const [, op, v] of mods) {
            const a = ms(m.at);
            const b = ms(v!);
            if (op === 'ge' && !(a >= b)) return false;
            if (op === 'gt' && !(a > b)) return false;
            if (op === 'lt' && !(a < b)) return false;
            if (op === 'eq' && a !== b) return false;
          }
          return !recGe || ms(m.rec ?? m.at) >= ms(recGe);
        })
        .sort((a, b) =>
          byReceived
            ? cmp(ms(a.rec ?? a.at), ms(b.rec ?? b.at))
            : cmp(ms(a.at), ms(b.at)) || cmp(ms(a.rec ?? a.at), ms(b.rec ?? b.at)),
        );
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
          receivedDateTime: toSecond(m.rec ?? m.at),
          lastModifiedDateTime: toSecond(m.at),
          hasAttachments: graph.withRef.has(m.id) || graph.slowAtt.has(m.id),
        })),
        ...(next ? { '@odata.nextLink': next } : {}),
      };
    }
    if (/\/attachments$/.test(u.pathname)) {
      const mid = decodeURIComponent(/\/messages\/([^/]+)\/attachments$/.exec(u.pathname)![1]!);
      if (graph.slowAtt.has(mid))
        return {
          value: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              id: 'a1',
              name: 'big.zip',
              size: 10,
            },
          ],
        };
      return {
        value: [{ '@odata.type': '#microsoft.graph.referenceAttachment', id: 'r1', name: 'Plan' }],
      };
    }
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
          receivedDateTime: toSecond(found.rec ?? found.at),
          lastModifiedDateTime: toSecond(found.at),
          hasAttachments: graph.slowAtt.has(id),
        };
      }
      if (graph.broken.has(id)) throw new real.GraphError(503, 'Microsoft Graph answered 503');
      if (graph.slow.has(id))
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return { body: { contentType: 'text', content: `body of ${id}` } };
    }
    throw new Error(`unexpected Graph call ${url}`);
  };
  return {
    ...real,
    accessToken: async () => 'token',
    // An attachment's bytes ($value): the slow one times out.
    graph: async (_token: string, url: string) => {
      graph.urls.push(url);
      if (url.includes('/attachments/a1/$value'))
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response('bytes');
    },
    graphJson: json,
    graphAll: async (token: string, path: string) =>
      ((await json(token, path)) as { value: unknown[] }).value,
  };
});

const { syncOutlook, RUN_PAGES } = await import('./outlook');
const { failuresFor, MESSAGE_GIVE_UP_MS, RETRY_PER_RUN, retryWaitMs } =
  await import('./mail-stream');
const RETRY_WAIT_FIRST = retryWaitMs(1);
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
  graph.slow = new Set();
  graph.slowAtt = new Set();
  graph.down = false;
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
  beforeEach(() => {
    clock = Date.now();
  });
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
    // It reads once Microsoft hands it out (after its wait): stored whole,
    // forgotten.
    graph.broken.delete('bad');
    clock += RETRY_WAIT_FIRST;
    await run(state, posted);
    expect(posted.map((p) => p.id)).toEqual(['good', 'bad']);
    expect(posted[1]!.body).toBe('body of bad');
    expect(kv.get('fails')).toEqual({});
  });

  it('is a stub only after three tries over a day, never for a short outage', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'bad', from: 'a@b.test', at: recent(1) }]);
    graph.broken.add('bad');
    const { state } = fakeState();
    const posted: { id: string; body?: string }[] = [];
    // Four tries over 18 hours: never a stub yet.
    for (let i = 0; i < 4; i++) {
      await run(state, posted);
      clock += 6 * 60 * 60_000; // past each wait
    }
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
    // Crossed over runs (where it got to is kept), the other folders going on.
    for (let i = 0; i < 4 && !posted.includes('after'); i++) {
      await syncOutlook(
        state,
        account,
        async (envs) => envs.map((e) => e.providerMsgId).filter((id) => !posted.includes(id)),
        async (m) => void posted.push(m.providerMsgId),
        async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      );
    }
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

describe('a timeout on one message', () => {
  const sync = (state: State, posted: string[], clock = () => Date.now()) =>
    syncOutlook(
      state,
      account,
      async (envs) => envs.map((e) => e.providerMsgId).filter((id) => !posted.includes(id)),
      async (m) => void posted.push(m.providerMsgId),
      async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      failuresFor(state, 'box', clock),
    );

  it("is that message's fault when Graph still answers: skipped, tried again", async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [
      { id: 'slow', from: 'a@b.test', at: recent(1) },
      { id: 'next', from: 'a@b.test', at: recent(2) },
    ]);
    graph.slow.add('slow');
    const { state, kv } = fakeState();
    const posted: string[] = [];
    await sync(state, posted);
    expect(posted).toEqual(['next']);
    expect(Object.keys(kv.get('fails') as object)).toEqual(['slow']);
  });

  it("is the run's when the network is down: nothing recorded, the watermark stays", async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'm', from: 'a@b.test', at: recent(1) }]);
    graph.down = true;
    const { state, kv } = fakeState();
    await expect(sync(state, [])).rejects.toThrow('fetch failed');
    expect(kv.get('fails')).toBeUndefined();
  });
});

describe('a group changed in one second, past what a run reads', () => {
  it('is crossed over runs, every message read, and the folder goes on', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    const t = toSecond(recent(5));
    const n = RUN_PAGES * 50 * 2 + 300; // over two runs' pages
    graph.messages.set('f0', [
      ...Array.from({ length: n }, (_, i) => ({
        id: `tie${i}`,
        from: 'a@b.test',
        // One printed second, kept finer.
        at: new Date(Date.parse(t) + (i % 997)).toISOString(),
        // 180 share one receivedDateTime too (pages at both keys).
        rec:
          i < 180
            ? toSecond(recent(-100))
            : new Date(Date.parse(recent(-90)) + i * 1000).toISOString(),
      })),
      { id: 'after', from: 'a@b.test', at: recent(9) },
    ]);
    const posted = new Set<string>();
    const { state, kv } = fakeState();
    const run = () =>
      syncOutlook(
        state,
        account,
        async (envs) => envs.map((e) => e.providerMsgId).filter((id) => !posted.has(id)),
        async (m) => void posted.add(m.providerMsgId),
        async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      );
    await run();
    expect(posted.has('after')).toBe(false);
    const between = kv.get('cursor') as { ties?: Record<string, { at: string; after: string }> };
    expect(between.ties?.f0?.at).toBe(t);
    for (let i = 0; i < 4 && !posted.has('after'); i++) await run();
    expect(posted.has('after')).toBe(true);
    expect([...posted].filter((p) => p.startsWith('tie'))).toHaveLength(n);
    // Past the group: new mail comes on the next run, from the next second.
    graph.messages.get('f0')!.push({ id: 'new', from: 'a@b.test', at: recent(20) });
    await run();
    expect(posted.has('new')).toBe(true);
    const last = graph.urls.filter((u) => u.includes('/mailFolders/f0/messages')).at(-1)!;
    expect(decodeURIComponent(last)).toContain('lastModifiedDateTime ge');
  });

  it('asks Graph on both keys, as its $orderby rule wants', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    const t = recent(5);
    graph.messages.set(
      'f0',
      Array.from({ length: 120 }, (_, i) => ({ id: `tie${i}`, from: 'a@b.test', at: t })),
    );
    const { state } = fakeState();
    await syncOutlook(
      state,
      account,
      async () => [],
      async () => {},
      async () => ({
        sha256: 'a'.repeat(64),
        size: 0,
      }),
    );
    const tieUrl = graph.urls.find((u) =>
      decodeURIComponent(u).includes('lastModifiedDateTime lt'),
    )!;
    const q = new URL(`https://graph.microsoft.com/v1.0${tieUrl}`).searchParams;
    // The ordered property first in the filter, as Graph's rule asks; the
    // group's whole second as a range.
    expect(q.get('$orderby')).toBe('receivedDateTime asc');
    expect(q.get('$filter')).toMatch(
      /^receivedDateTime ge \S+ and lastModifiedDateTime ge \S+ and lastModifiedDateTime lt \S+$/,
    );
  });
});

describe('the messages that failed before', () => {
  it('are tried after the new mail, at most RETRY_PER_RUN a run, each after its wait', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    const failed = Array.from({ length: 40 }, (_, i) => ({
      id: `old${i}`,
      from: 'a@b.test',
      at: recent(-50 + i),
    }));
    graph.messages.set('f0', [...failed, { id: 'fresh', from: 'a@b.test', at: recent(30) }]);
    let clock = Date.now();
    const { state } = fakeState();
    const failures = failuresFor(state, 'box', () => clock);
    for (const f of failed) await failures.record(f.id, 'Inbox');
    const posted: string[] = [];
    // The failed ones were already past the watermark.
    await state.putMsCursor('acc', { since: null, folders: { f0: recent(29) } });
    const run = () =>
      syncOutlook(
        state,
        account,
        async (envs) => envs.map((e) => e.providerMsgId).filter((id) => !posted.includes(id)),
        async (m) => void posted.push(m.providerMsgId),
        async () => ({ sha256: 'a'.repeat(64), size: 0 }),
        failures,
      );
    // Before the wait: none tried.
    await run();
    expect(posted).toEqual(['fresh']);
    clock += retryWaitMs(1);
    await run();
    expect(posted[0]).toBe('fresh');
    expect(posted.length).toBe(1 + RETRY_PER_RUN);
    await run();
    expect(posted.length).toBe(1 + 40);
  });
});

describe('a full queue of failed messages', () => {
  it('still gives the retry its turn, so it drains and the mailbox goes on', async () => {
    const { FAILURES_MAX } = await import('./mail-stream');
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `old${i}`,
        from: 'a@b.test',
        at: recent(-80 + i),
      })),
      { id: 'bad', from: 'a@b.test', at: recent(40) },
    ]);
    graph.broken.add('bad');
    let clock = Date.now();
    const { state } = fakeState();
    const failures = failuresFor(state, 'box', () => clock);
    // The queue full: 30 that read now, the rest gone from the mailbox.
    for (let i = 0; i < 30; i++) await failures.record(`old${i}`, 'Inbox');
    for (let i = 30; i < FAILURES_MAX; i++) await failures.record(`gone${i}`, 'Inbox');
    clock += retryWaitMs(1);
    await state.putMsCursor('acc', { since: null, folders: { f0: recent(39) } });
    const posted: string[] = [];
    const run = () =>
      syncOutlook(
        state,
        account,
        async (envs) => envs.map((e) => e.providerMsgId).filter((id) => !posted.includes(id)),
        async (m) => void posted.push(m.providerMsgId),
        async () => ({ sha256: 'a'.repeat(64), size: 0 }),
        failures,
      );
    await expect(run()).rejects.toThrow(/fail to read/);
    // The retry had its turn: 25 read, the gone ones let go.
    expect(posted.length).toBe(RETRY_PER_RUN);
    // Places freed: the next run keeps the new failing message and ends well.
    await run();
    expect((await failures.ids()).has('bad')).toBe(true);
  });
});

describe('the last try of a message', () => {
  it('keeps the body and names a slow attachment, never a bare stub', async () => {
    graph.folders = [{ id: 'f0', displayName: 'Inbox' }];
    graph.messages.set('f0', [{ id: 'm', from: 'a@b.test', at: recent(1) }]);
    graph.slowAtt.add('m');
    let clock = Date.now();
    const { state } = fakeState();
    const failures = failuresFor(state, 'box', () => clock);
    const posted: { id: string; body?: string }[] = [];
    const run = () =>
      syncOutlook(
        state,
        account,
        async (envs) =>
          envs.map((e) => e.providerMsgId).filter((id) => !posted.some((p) => p.id === id)),
        async (m) => void posted.push({ id: m.providerMsgId, body: m.bodyText }),
        async () => ({ sha256: 'a'.repeat(64), size: 0 }),
        failures,
      );
    for (let i = 0; i < 4; i++) {
      await run();
      clock += 6 * 60 * 60_000;
    }
    expect(posted).toEqual([]);
    clock += MESSAGE_GIVE_UP_MS;
    await run();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain('body of m');
    expect(posted[0]!.body).toContain('big.zip');
  });
});

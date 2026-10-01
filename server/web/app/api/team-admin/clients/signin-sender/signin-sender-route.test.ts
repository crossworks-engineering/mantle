/**
 * The client sign-in sender route (client logins C2b) without a database:
 * the accounts and preferences are stood in, so these pin the route
 * contract jackdaw builds on. Only an account that can send is taken (404
 * for none, 400 for one that cannot send, 409 when its sent folder cannot
 * be found or its folders cannot be listed, and nothing is saved then);
 * picking one leaves its sent-mail folders out of sync, and any other
 * choice (None, another account) puts back what an earlier choice left out;
 * the card counts delivered and failed mails, the newest failure, the cap
 * skips and whether an email worker serves the queue; the daily cap shows
 * as capReached. The preview says the same before the choice. Members and
 * clients are refused by getOwnerOr401 (the sweeps drive every route).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const GOOD = '77777777-7777-4777-8777-777777777777';
const MUTE = '88888888-8888-4888-8888-888888888888';

type Refusal = 'no-sent-folder' | 'folders-unreadable' | 'account-not-found';

const h = vi.hoisted(() => ({
  saved: [] as Array<Record<string, unknown>>,
  excluded: [] as string[],
  restored: [] as Array<string | null>,
  refusal: null as null | 'no-sent-folder' | 'folders-unreadable' | 'account-not-found',
  held: [] as string[],
  sender: null as null | Record<string, unknown>,
  stats: {
    created: 0,
    delivered: 0,
    failed: 0,
    lastFailure: null as null | { at: Date; reason: string },
    capSkips: 0,
  },
  worker: true,
  existing: [] as string[],
}));

const account = (id: string, address: string, excluded: string[] = []) => ({
  id,
  address,
  imapExcludedFolders: excluded,
});

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));
vi.mock('@/lib/audit', () => ({ auditFireAndForget: () => {}, requestMetaFrom: () => ({}) }));
vi.mock('@/lib/client-codes', () => ({
  clientSenderCandidates: vi.fn(async () => [account(GOOD, 'signin@example.invalid')]),
  loadClientSigninSender: vi.fn(async () => h.sender),
  senderCandidateOf: (a: { id: string; address: string }) => ({ id: a.id, address: a.address }),
  emailWorkerServesCodes: vi.fn(async () => h.worker),
}));
vi.mock('@mantle/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  excludeSentFolders: vi.fn(async (_owner: string, id: string) => {
    if (h.refusal) return { ok: false, reason: h.refusal, error: 'x' };
    h.excluded.push(id);
    return { ok: true, excluded: ['Sent'], added: ['Sent'] };
  }),
  planSentFolders: vi.fn(async () =>
    h.refusal
      ? { ok: false, reason: h.refusal, error: 'x' }
      : { ok: true, account: {}, sentFolders: ['INBOX.Sent'] },
  ),
  restoreSentFolders: vi.fn(async (_owner: string, keep: string | null) => {
    h.restored.push(keep);
    return [];
  }),
  heldSentFolders: vi.fn(async () => h.held),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clientCodeStats: vi.fn(async () => h.stats),
  savePreferencesFor: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    h.saved.push(patch);
    return {};
  }),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSingleOwnerId: vi.fn(async () => ANCHOR),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => h.existing.map((id) => ({ id })) }),
      }),
    }),
  },
}));

beforeEach(() => {
  h.saved = [];
  h.excluded = [];
  h.restored = [];
  h.refusal = null;
  h.held = [];
  h.sender = null;
  h.stats = { created: 0, delivered: 0, failed: 0, lastFailure: null, capSkips: 0 };
  h.worker = true;
  h.existing = [];
});

const put = async (body: unknown) => {
  const { PUT } = await import('./route');
  return PUT(
    new Request('https://brain.example.invalid/api/team-admin/clients/signin-sender', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

const preview = async (accountId: string) => {
  const { GET } = await import('./preview/route');
  return GET(
    new Request(
      `https://brain.example.invalid/api/team-admin/clients/signin-sender/preview?accountId=${accountId}`,
    ),
  );
};

describe('GET /api/team-admin/clients/signin-sender', () => {
  it('shows codes off, the candidates and the counts', async () => {
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toEqual({
      sender: null,
      candidates: [{ id: GOOD, address: 'signin@example.invalid' }],
      sentFoldersExcluded: [],
      dailyCap: 200,
      sentLast24h: 0,
      capReached: false,
      deliveredLast24h: 0,
      failedLast24h: 0,
      lastFailure: null,
      emailWorker: true,
      capSkipsLast24h: 0,
    });
  });

  it('shows the sender, its excluded sent folders, and the cap when reached', async () => {
    h.sender = account(GOOD, 'signin@example.invalid', ['Trash', 'INBOX.Sent', 'Sent Items']);
    h.stats = { created: 200, delivered: 200, failed: 0, lastFailure: null, capSkips: 0 };
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toMatchObject({
      sender: { id: GOOD, address: 'signin@example.invalid' },
      sentFoldersExcluded: ['INBOX.Sent', 'Sent Items'],
      sentLast24h: 200,
      capReached: true,
    });
  });

  it('names a held folder by any name (a \\Sent flag in another language)', async () => {
    h.sender = account(GOOD, 'signin@example.invalid', ['Trash', 'Gesendet']);
    h.held = ['Gesendet', 'Gone'];
    const { GET } = await import('./route');
    expect((await (await GET()).json()).sentFoldersExcluded).toEqual(['Gesendet']);
  });

  it('counts only delivered mails as sent, and shows failures, skips and the worker (B3)', async () => {
    h.sender = account(GOOD, 'signin@example.invalid');
    h.stats = {
      created: 7,
      delivered: 4,
      failed: 3,
      lastFailure: { at: new Date('2026-09-29T08:00:00Z'), reason: '535 auth failed' },
      capSkips: 11,
    };
    h.worker = false;
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toMatchObject({
      sentLast24h: 4,
      deliveredLast24h: 4,
      failedLast24h: 3,
      lastFailure: { at: '2026-09-29T08:00:00.000Z', reason: '535 auth failed' },
      capSkipsLast24h: 11,
      emailWorker: false,
      capReached: false,
    });
  });

  it('reaches the cap on stored codes, failed ones too', async () => {
    h.stats = { created: 200, delivered: 150, failed: 50, lastFailure: null, capSkips: 0 };
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toMatchObject({ sentLast24h: 150, capReached: true });
  });
});

describe('PUT /api/team-admin/clients/signin-sender', () => {
  it('takes an account that can send, leaves its sent mail out, and restores any other', async () => {
    const res = await put({ accountId: GOOD });
    expect(res.status).toBe(200);
    expect(h.excluded).toEqual([GOOD]);
    expect(h.saved).toEqual([{ clientSigninSenderId: GOOD }]);
    // Folders an earlier sender left out come back; this sender's stay.
    expect(h.restored).toEqual([GOOD]);
  });

  it('turns codes off with null and puts back every held folder (B4)', async () => {
    expect((await put({ accountId: null })).status).toBe(200);
    expect(h.saved).toEqual([{ clientSigninSenderId: '' }]);
    expect(h.excluded).toEqual([]);
    expect(h.restored).toEqual([null]);
  });

  it('refuses a mailbox with no sent folder, or folders it cannot list: 409, nothing saved (B19)', async () => {
    for (const reason of ['no-sent-folder', 'folders-unreadable'] as Refusal[]) {
      h.refusal = reason;
      const res = await put({ accountId: GOOD });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe(reason);
    }
    expect(h.saved).toEqual([]);
    expect(h.restored).toEqual([]);
  });

  it('refuses an account that cannot send (400) or does not exist (404), saving nothing', async () => {
    h.existing = [MUTE];
    const cannot = await put({ accountId: MUTE });
    expect(cannot.status).toBe(400);
    expect((await cannot.json()).reason).toBe('account-cannot-send');
    h.existing = [];
    const missing = await put({ accountId: MUTE });
    expect(missing.status).toBe(404);
    expect((await missing.json()).reason).toBe('account-not-found');
    expect((await put({ accountId: 'nope' })).status).toBe(400);
    expect(h.saved).toEqual([]);
    expect(h.excluded).toEqual([]);
    expect(h.restored).toEqual([]);
  });
});

describe('GET /api/team-admin/clients/signin-sender/preview', () => {
  it('names the sent folders the choice would leave out', async () => {
    const res = await preview(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentFolders: ['INBOX.Sent'], canUse: true });
    expect(h.saved).toEqual([]);
    expect(h.excluded).toEqual([]);
  });

  it('says why a mailbox cannot be chosen', async () => {
    h.refusal = 'no-sent-folder';
    expect(await (await preview(GOOD)).json()).toEqual({
      sentFolders: [],
      canUse: false,
      reason: 'no-sent-folder',
    });
    h.refusal = 'folders-unreadable';
    expect((await (await preview(GOOD)).json()).reason).toBe('folders-unreadable');
    h.existing = [MUTE];
    expect(await (await preview(MUTE)).json()).toEqual({
      sentFolders: [],
      canUse: false,
      reason: 'account-cannot-send',
    });
  });

  it('404 for an unknown account, 400 for a malformed id', async () => {
    expect((await preview(MUTE)).status).toBe(404);
    expect((await preview('nope')).status).toBe(400);
  });
});

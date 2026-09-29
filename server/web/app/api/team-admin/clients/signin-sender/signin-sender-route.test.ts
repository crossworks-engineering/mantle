/**
 * The client sign-in sender route (client logins C2b) without a database:
 * the accounts and preferences are stood in, so these pin the route
 * contract jackdaw builds on. Only an account that can send is taken (404
 * for none, 400 for one that cannot send, and nothing is saved then);
 * picking one leaves its sent-mail folders out of sync; None stores '' (codes
 * off); the daily cap shows as capReached. Members and clients are refused
 * by getOwnerOr401 (the sweeps drive every route).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const GOOD = '77777777-7777-4777-8777-777777777777';
const MUTE = '88888888-8888-4888-8888-888888888888';

const h = vi.hoisted(() => ({
  saved: [] as Array<Record<string, unknown>>,
  excluded: [] as string[],
  sender: null as null | Record<string, unknown>,
  sent: 0,
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
}));
vi.mock('@mantle/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  excludeSentFolders: vi.fn(async (_owner: string, id: string) => {
    h.excluded.push(id);
    return { ok: true, excluded: ['Sent'] };
  }),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clientCodesSentLast24h: vi.fn(async () => h.sent),
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
  h.sender = null;
  h.sent = 0;
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

describe('GET /api/team-admin/clients/signin-sender', () => {
  it('shows codes off, the candidates and the count', async () => {
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toEqual({
      sender: null,
      candidates: [{ id: GOOD, address: 'signin@example.invalid' }],
      sentFoldersExcluded: [],
      dailyCap: 200,
      sentLast24h: 0,
      capReached: false,
    });
  });

  it('shows the sender, its excluded sent folders, and the cap when reached', async () => {
    h.sender = account(GOOD, 'signin@example.invalid', ['Trash', 'INBOX.Sent', 'Sent Items']);
    h.sent = 200;
    const { GET } = await import('./route');
    expect(await (await GET()).json()).toMatchObject({
      sender: { id: GOOD, address: 'signin@example.invalid' },
      sentFoldersExcluded: ['INBOX.Sent', 'Sent Items'],
      sentLast24h: 200,
      capReached: true,
    });
  });
});

describe('PUT /api/team-admin/clients/signin-sender', () => {
  it('takes an account that can send, and leaves its sent mail out of sync', async () => {
    const res = await put({ accountId: GOOD });
    expect(res.status).toBe(200);
    expect(h.excluded).toEqual([GOOD]);
    expect(h.saved).toEqual([{ clientSigninSenderId: GOOD }]);
  });

  it('turns codes off with null', async () => {
    expect((await put({ accountId: null })).status).toBe(200);
    expect(h.saved).toEqual([{ clientSigninSenderId: '' }]);
    expect(h.excluded).toEqual([]);
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
  });
});

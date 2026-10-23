/**
 * POST /api/users when the insert loses a race, without a database. Drizzle
 * wraps the Postgres error: the top message is "Failed query: ..." and the
 * 23505 sits on `cause`. The route used to read the message, so a duplicate
 * answered 500; it must answer 409, and name the rule it hit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  insertError: null as unknown,
  inserted: null as null | Record<string, unknown>,
  executed: [] as string[],
  // Transactions opened, and the one each bridge call ran in.
  txCount: 0,
  executedInTx: [] as number[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The route reads the caller the pipeline answers (A4 step 3b part 4).
  ownerCaller: vi.fn(() => ({
    id: ANCHOR,
    actor: { id: ANCHOR, email: 'admin@example.invalid' },
  })),
  hashLoginPassword: vi.fn(async () => 'hash'),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: vi.fn(),
  requestMetaFrom: () => ({}),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => h.selects.shift() ?? [],
  };
  // The insert and the login's Admin and Team rows (0261) run only on the
  // transaction, never on the bare handle.
  let inTx = 0;
  const tx = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (!inTx) throw new Error('insert outside the transaction');
        h.inserted = row;
        if (h.insertError) throw h.insertError;
      },
    }),
    execute: async (q: { queryChunks?: unknown[] }) => {
      if (!inTx) throw new Error('bridge outside the transaction');
      h.executed.push(JSON.stringify(q.queryChunks ?? q));
      h.executedInTx.push(h.txCount);
      // The lookup answers the brain's one live Admin workspace; the add
      // answers its one row.
      return [{ owner: ANCHOR, ws: ANCHOR, member: false }];
    },
  };
  const open = async (fn: (t: typeof tx) => Promise<unknown>) => {
    h.txCount++;
    inTx++;
    try {
      return await fn(tx);
    } finally {
      inTx--;
    }
  };
  return {
    ...(await importOriginal<typeof import('@mantle/db')>()),
    db: {
      select: () => chain,
      transaction: open,
    },
  };
});

/** The shape drizzle 0.45 throws (pinned by packages/db/src/pg-error.db.test.ts). */
function drizzleError(code: string, constraint?: string): Error {
  return Object.assign(
    new Error('Failed query: insert into "auth"."users" (...) values (...)\nparams: ...'),
    { cause: { code, constraint_name: constraint } },
  );
}

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BODY = { email: 'new@example.invalid', password: 'long-enough-pw', role: 'member' };

describe('POST /api/users, the insert refused', () => {
  beforeEach(() => {
    h.selects = [];
    h.insertError = null;
    h.inserted = null;
    h.executed = [];
    h.txCount = 0;
    h.executedInTx = [];
  });

  it('answers 409 for a duplicate email', async () => {
    h.insertError = drizzleError('23505', 'users_email_key');
    const { POST } = await import('./route');
    const res = await POST(post(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A user with that email already exists.' });
    expect(h.executed).toEqual([]);
  });

  it('answers 409 naming the contact when the contact already has a login', async () => {
    h.selects = [[{ id: CONTACT }], []]; // the contact exists; no email clash
    h.insertError = drizzleError('23505', 'users_contact_id_unique');
    const { POST } = await import('./route');
    const res = await POST(post({ ...BODY, contactId: CONTACT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'That contact is already linked to another user.',
    });
  });

  it('makes a member when no role is given; an admin only when asked for (W5a fix round 3)', async () => {
    const { POST } = await import('./route');
    const noRole = { email: BODY.email, password: BODY.password };
    const plain = await POST(post(noRole));
    expect(plain.status).toBe(201);
    expect(h.inserted).toMatchObject({ role: 'member', isOwner: false });
    const admin = await POST(post({ ...noRole, email: 'adm@example.invalid', role: 'admin' }));
    expect(admin.status).toBe(201);
    // Inserted a member; the membership definer adds it to Admin and writes
    // the role, as the caller (the exit's acting login), in the same
    // transaction.
    expect(h.inserted).toMatchObject({ role: 'member' });
    // The live Admin workspace (liveAdminWorkspace), then the add.
    expect(h.executed).toHaveLength(2);
    expect(h.executed[0]).toContain('is_admin');
    expect(h.executed[1]).toContain('mantle_ws_add_user');
    // Each login in its own one transaction; the member's runs no statement.
    expect(h.txCount).toBe(2);
    expect(h.executedInTx).toEqual([2, 2]);
  });

  it("refuses a former client's email, before any write (W8a fix round 1, L6)", async () => {
    h.selects = [[{ id: CONTACT }]]; // archive_client_logins names the email
    const { POST } = await import('./route');
    const res = await POST(post(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'That email belonged to a client login. A former client cannot be invited or given a new login.',
      reason: 'email-was-client',
    });
    expect(h.inserted).toBeNull();
    expect(h.txCount).toBe(0);
  });

  it('refuses a contact a former client login had, before any write (W8a fix round 2, L)', async () => {
    // The contact exists; archive_client_logins names it.
    h.selects = [[{ id: CONTACT }], [{ id: CONTACT }]];
    const { POST } = await import('./route');
    const res = await POST(post({ ...BODY, contactId: CONTACT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'That contact belonged to a client login. A former client cannot be invited or given a new login.',
      reason: 'contact-was-client',
    });
    expect(h.inserted).toBeNull();
    expect(h.txCount).toBe(0);
  });

  it('still answers 500 for any other database error', async () => {
    h.insertError = drizzleError('23503');
    const { POST } = await import('./route');
    const res = await POST(post(BODY));
    expect(res.status).toBe(500);
  });
});

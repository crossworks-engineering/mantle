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
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
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
  return {
    ...(await importOriginal<typeof import('@mantle/db')>()),
    db: {
      select: () => chain,
      insert: () => ({
        values: async () => {
          if (h.insertError) throw h.insertError;
        },
      }),
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
  });

  it('answers 409 for a duplicate email', async () => {
    h.insertError = drizzleError('23505', 'users_email_key');
    const { POST } = await import('./route');
    const res = await POST(post(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A user with that email already exists.' });
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

  it('still answers 500 for any other database error', async () => {
    h.insertError = drizzleError('23503');
    const { POST } = await import('./route');
    const res = await POST(post(BODY));
    expect(res.status).toBe(500);
  });
});

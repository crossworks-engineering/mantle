/**
 * The admin invite routes (member logins, Phase 6) without a database: the
 * invite logic is stood in, so these pin the route contract the client
 * builds on. The code and link path come back once on create; refusals map
 * to 400/409; revoke is 404 for anything not open. A member login is refused
 * by the gate (proven for every route in server/member-sweep.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const INVITE = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  createError: null as null | { reason: string; message: string },
  created: [] as Array<{ ownerId: string; input: Record<string, unknown> }>,
  revoked: [] as string[],
  revokeResult: true,
}));

const ROW = {
  id: INVITE,
  contactId: CONTACT,
  contactName: 'Pat',
  email: 'pat@example.invalid',
  displayName: 'Pat',
  state: 'open',
  createdAt: '2026-09-28T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
  redeemedAt: null,
  redeemedLoginId: null,
  createdBy: ACTOR,
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...real,
    createMemberInvite: vi.fn(async (ownerId: string, input: Record<string, unknown>) => {
      h.created.push({ ownerId, input });
      if (h.createError) {
        throw new real.MemberInviteError(
          h.createError.reason as import('@mantle/content').MemberInviteErrorReason,
          h.createError.message,
        );
      }
      return { invite: ROW, code: 'AbCd+EfGh/JkMnPq' };
    }),
    listMemberInvites: vi.fn(async () => [ROW]),
    revokeMemberInvite: vi.fn(async (_owner: string, id: string) => {
      h.revoked.push(id);
      return h.revokeResult;
    }),
  };
});

beforeEach(() => {
  h.createError = null;
  h.created = [];
  h.revoked = [];
  h.revokeResult = true;
});

const create = async (body: unknown) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/team-admin/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

describe('/api/team-admin/invites', () => {
  it('creates an invite and returns the code and link path once', async () => {
    const res = await create({ contactId: CONTACT });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      invite: ROW,
      code: 'AbCd+EfGh/JkMnPq',
      linkPath: '/invite?code=AbCd%2BEfGh%2FJkMnPq',
    });
    // Scoped to the brain, attributed to the admin login.
    expect(h.created[0]).toEqual({
      ownerId: ANCHOR,
      input: { contactId: CONTACT, createdBy: ACTOR },
    });
  });

  it('maps the refusals to 409 (a login exists) and 400', async () => {
    const cases: Array<[string, number]> = [
      ['email-has-login', 409],
      ['contact-has-login', 409],
      ['contact-not-found', 400],
      ['no-email', 400],
    ];
    for (const [reason, status] of cases) {
      h.createError = { reason, message: reason };
      const res = await create({ email: 'pat@example.invalid' });
      expect(res.status, reason).toBe(status);
      expect(((await res.json()) as { reason?: string }).reason).toBe(reason);
    }
  });

  it('refuses a malformed body before creating anything', async () => {
    for (const body of [{ contactId: 'not-a-uuid' }, { email: 'not an email' }]) {
      expect((await create(body)).status).toBe(400);
    }
    expect(h.created).toHaveLength(0);
  });

  it('lists invites without codes', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: Array<Record<string, unknown>> };
    expect(body.invites).toEqual([ROW]);
    expect(JSON.stringify(body)).not.toMatch(/code/i);
  });

  it('revokes an open invite; anything else is a 404', async () => {
    const { DELETE } = await import('./[id]/route');
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const req = new Request('https://brain.example.invalid/x', { method: 'DELETE' });
    expect((await DELETE(req, ctx(INVITE))).status).toBe(200);
    h.revokeResult = false;
    expect((await DELETE(req, ctx(INVITE))).status).toBe(404);
    expect((await DELETE(req, ctx('not-a-uuid'))).status).toBe(404);
    expect(h.revoked).toEqual([INVITE, INVITE]);
  });
});

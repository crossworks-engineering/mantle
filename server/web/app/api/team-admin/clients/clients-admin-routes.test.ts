/**
 * The admin client routes (client logins C2) without a database: the
 * client-login logic is stood in, so these pin the route contract jackdaw
 * builds on. Create hands the logic a bcrypt hash of a random secret (no
 * password opens a client); refusals map to 409 (the report is not
 * acknowledged, the email or contact has a login), 404 (not a client) or
 * 400; the link code and path come back once. Members and clients are
 * refused by getOwnerOr401 (proven for every route in the sweeps).
 */
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const CLIENT = '12121212-1212-4212-8212-121212121212';

const h = vi.hoisted(() => ({
  error: null as null | { reason: string; message: string },
  created: [] as Array<Record<string, unknown>>,
  acknowledged: true,
  revokeResult: true,
}));

const ROW = {
  id: CLIENT,
  email: 'client@example.invalid',
  displayName: 'Client',
  contactId: null,
  disabled: false,
  createdAt: '2026-09-29T00:00:00.000Z',
  lastLoginAt: null,
  openLink: null,
  lastLinkUsedAt: null,
};
const LINK = {
  id: 'l1',
  createdAt: '2026-09-29T00:00:00.000Z',
  expiresAt: '2026-10-02T00:00:00.000Z',
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'admin@example.invalid',
    actor: { id: ACTOR, email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => {},
  requestMetaFrom: () => ({}),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  const fail = () => {
    if (h.error) {
      throw new real.ClientLoginError(
        h.error.reason as import('@mantle/client-types').ClientAdminRefusedReason,
        h.error.message,
      );
    }
  };
  return {
    ...real,
    createClientLogin: vi.fn(async (_owner: string, input: Record<string, unknown>) => {
      h.created.push(input);
      fail();
      return ROW;
    }),
    listClientLogins: vi.fn(async () => [ROW]),
    clientReportAcknowledged: vi.fn(async () => h.acknowledged),
    issueClientSigninLink: vi.fn(async () => {
      fail();
      return { link: LINK, code: 'AbCdEfGhJkMnPqRs' };
    }),
    revokeClientSigninLink: vi.fn(async () => h.revokeResult),
  };
});

beforeEach(() => {
  h.error = null;
  h.created = [];
  h.acknowledged = true;
  h.revokeResult = true;
});

const create = async (body: unknown) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/team-admin/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};
const linkCall = async (method: 'POST' | 'DELETE', id = CLIENT) => {
  const mod = await import('./[id]/signin-link/route');
  return mod[method](
    new Request(`https://brain.example.invalid/api/team-admin/clients/${id}/signin-link`, {
      method,
    }),
    { params: Promise.resolve({ id }) },
  );
};

describe('GET /api/team-admin/clients', () => {
  it('lists client logins and whether the report is acknowledged', async () => {
    h.acknowledged = false;
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [ROW], reportAcknowledged: false });
  });
});

describe('POST /api/team-admin/clients', () => {
  it('makes a client with a hash nobody knows the secret of', async () => {
    const res = await create({ email: 'client@example.invalid', displayName: 'Client' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ client: ROW });
    const input = h.created[0]!;
    expect(input).toMatchObject({ email: 'client@example.invalid', createdBy: ACTOR });
    const hash = input.unusablePasswordHash as string;
    expect(hash).toMatch(/^\$2[aby]\$/);
    // Not a hash of anything a person would type, nor of the empty string.
    for (const guess of ['', 'client@example.invalid', 'password']) {
      expect(await bcrypt.compare(guess, hash)).toBe(false);
    }
    await create({ email: 'client@example.invalid' });
    expect(h.created[1]!.unusablePasswordHash).not.toBe(hash);
  });

  it('maps refusals: 409 report, 409 existing login, 400 no email, 400 bad body', async () => {
    for (const [reason, status] of [
      ['report-not-acknowledged', 409],
      ['email-has-login', 409],
      ['contact-has-login', 409],
      ['no-email', 400],
      ['contact-not-found', 400],
    ] as const) {
      h.error = { reason, message: reason };
      const res = await create({ email: 'client@example.invalid' });
      expect(res.status, reason).toBe(status);
      expect((await res.json()).reason).toBe(reason);
    }
    h.error = null;
    expect((await create({ email: 'not an email' })).status).toBe(400);
  });
});

describe('/api/team-admin/clients/:id/signin-link', () => {
  it('issues a link: the code and path once', async () => {
    const res = await linkCall('POST');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      link: LINK,
      code: 'AbCdEfGhJkMnPqRs',
      path: '/client-signin#code=AbCdEfGhJkMnPqRs',
    });
  });

  it('refuses: 409 until the report is acknowledged, 404 for no client', async () => {
    h.error = { reason: 'report-not-acknowledged', message: 'x' };
    expect((await linkCall('POST')).status).toBe(409);
    h.error = { reason: 'not-a-client', message: 'x' };
    expect((await linkCall('POST')).status).toBe(404);
    h.error = null;
    expect((await linkCall('POST', 'not-a-uuid')).status).toBe(404);
  });

  it('revokes the open link, 404 when there is none', async () => {
    expect((await linkCall('DELETE')).status).toBe(200);
    h.revokeResult = false;
    expect((await linkCall('DELETE')).status).toBe(404);
  });
});

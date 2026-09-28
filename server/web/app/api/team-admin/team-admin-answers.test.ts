/**
 * The team-admin tab answers without a database (member logins Phase 6
 * cleanup): the forum, upload and curated-tag parts that stayed one contract
 * cycle for older clients are gone. Each answer is pinned to its exact key
 * set, so a retired field coming back fails here:
 *
 * - badges: `{ openRequestCount }` (no `openRequests`, no `pendingUploadCount`)
 * - GET requests: `{ badges, requests }` (no `uploads`, no `moreUploads`)
 * - GET settings: no `dashboardTags`
 * - GET members: rows with no `forum`, `selected` with no posts, authored
 *   topics or activity paging
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const APP = '88888888-8888-4888-8888-888888888888';

const h = vi.hoisted(() => ({ openRequests: 2 }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  listTeamRequests: vi.fn(async (_owner: string, opts: { status: string }) =>
    opts.status === 'open'
      ? Array.from({ length: h.openRequests }, (_, i) => ({ taskId: `t${i}` }))
      : [{ taskId: 't0' }],
  ),
  listTeamMemberActivity: vi.fn(async () => [
    {
      contactId: CONTACT,
      contactName: 'Ana',
      memberSince: '2026-09-01T00:00:00.000Z',
      lastMessageAt: '2026-09-02T00:00:00.000Z',
      lastMessageText: 'hello',
      lastMessageDirection: 'inbound',
      messageCount: 1,
      unread: 1,
    },
  ]),
  listTeamThread: vi.fn(async () => []),
  listTeamAccess: vi.fn(async () => []),
  loadProfilePreferences: vi.fn(async () => ({ teamHubAppId: APP, teamHubTags: ['faq'] })),
  isTeamPrivateReadsEnabled: vi.fn(() => false),
  listApps: vi.fn(async () => [{ id: APP, title: 'Home', hasBuild: true }]),
}));

beforeEach(() => {
  h.openRequests = 2;
});

const keys = (o: object) => Object.keys(o).sort();

describe('teamAdminBadges', () => {
  it('is exactly { openRequestCount }', async () => {
    const { teamAdminBadges } = await import('@/lib/team-admin-overview');
    expect(await teamAdminBadges(ANCHOR)).toStrictEqual({ openRequestCount: 2 });
  });
});

describe('GET /api/team-admin/requests', () => {
  it('answers { badges, requests } and nothing about uploads', async () => {
    const { GET } = await import('./requests/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(keys(body)).toEqual(['badges', 'requests']);
    expect(body.badges).toStrictEqual({ openRequestCount: 2 });
  });
});

describe('GET /api/team-admin/settings', () => {
  it('answers no dashboardTags', async () => {
    const { GET } = await import('./settings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(keys(body)).toEqual(['badges', 'hubAppId', 'hubCandidates', 'privateReads']);
    expect(body.hubAppId).toBe(APP);
  });
});

describe('GET /api/team-admin/members', () => {
  it('answers rows with no forum and a selection with no forum parts', async () => {
    const { GET } = await import('./members/route');
    const res = await GET(new Request('https://brain.example.invalid/api/team-admin/members'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<Record<string, unknown>>;
      selected: Record<string, unknown>;
    };
    expect(keys(body)).toEqual(['badges', 'members', 'selected']);
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).not.toHaveProperty('forum');
    expect(keys(body.selected)).toEqual(['access', 'contactId', 'requests', 'thread']);
    expect(body.selected.contactId).toBe(CONTACT);
  });
});

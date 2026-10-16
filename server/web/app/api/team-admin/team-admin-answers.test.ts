/**
 * The team-admin tab answers without a database (member logins Phase 6
 * cleanup): the forum, upload and curated-tag parts that stayed one contract
 * cycle for older clients are gone. Each answer is pinned to its exact key
 * set, so a retired field coming back fails here:
 *
 * - badges: `{ openRequestCount }` (no `openRequests`, no `pendingUploadCount`)
 * - GET settings: no `dashboardTags`, no `teamAgent` (no agent level is read,
 *   W5c); `hubAppId` null and `hubCandidates` empty (the home app is a
 *   workspace setting since task d78e7bde; kept one release for an older
 *   client); `teamAssistant` null (no workspace is the members' since 0286)
 *
 * GET requests was removed in W5c (a 410 stub until arch A7,
 * server/web/server/a7-gone-routes.test.ts).
 *
 * GET members (the Chat archive) was removed on 2026-10-09; auth-sweep.test.ts
 * pins its 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const APP = '88888888-8888-4888-8888-888888888888';

const h = vi.hoisted(() => ({
  openRequests: 2,
  agentAccess: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The route reads the caller the pipeline answers (A4 step 3b part 4).
  ownerCaller: vi.fn(() => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  countOpenTeamRequests: vi.fn(async () => h.openRequests),
  loadProfilePreferences: vi.fn(async () => ({ teamHubAppId: APP, teamHubTags: ['faq'] })),
  isTeamPrivateReadsEnabled: vi.fn(() => false),
  getAgentAccess: h.agentAccess,
}));

beforeEach(() => {
  h.openRequests = 2;
  h.agentAccess.mockReset();
});

const keys = (o: object) => Object.keys(o).sort();

describe('teamAdminBadges', () => {
  it('is exactly { openRequestCount }', async () => {
    const { teamAdminBadges } = await import('@/lib/team-admin-overview');
    expect(await teamAdminBadges(ANCHOR)).toStrictEqual({ openRequestCount: 2 });
  });
});

describe('GET /api/team-admin/settings', () => {
  it('answers no dashboardTags and no agent level; the Team assistant or null', async () => {
    const { GET } = await import('./settings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(keys(body)).toEqual([
      'badges',
      'hubAppId',
      'hubCandidates',
      'privateReads',
      'teamAssistant',
    ]);
    // The home app is a workspace setting: an older client's picker gets
    // nothing to show (kept one release, audit M3).
    expect(body.hubAppId).toBeNull();
    expect(body.hubCandidates).toEqual([]);
    // No workspace is the members' since 0286: always null.
    expect(body.teamAssistant).toBeNull();
    // The team-responder's level is never read.
    expect(h.agentAccess).not.toHaveBeenCalled();
  });
});

/**
 * POST /api/apps/:id/db-broker and a draft an in-app agent saved last
 * (docs/agent-ui.md, migration 0365): the draft's build runs no query and
 * no write, tagged or not, with the tool broker's 403
 * `{ error, reason: 'agent_edited_draft' }`; a draft a person saved, the
 * published build and a member's run (lib/app-runner.ts) run as before. No database: the login, the runtime
 * row and the SQLite work are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runtime: null as Record<string, unknown> | null,
  ran: 0,
  admin: true,
  member: 0,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerLoginCaller: () => ({
    brainId: 'owner-1',
    actor: { id: 'a1', email: 'a@example.invalid', displayName: 'Ada' },
  }),
}));
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn(async () => ({ admin: h.admin, areas: new Set() })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async () => h.runtime),
}));
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbQuery: vi.fn(async () => {
    h.ran += 1;
    return { columns: [], rows: [] };
  }),
}));
vi.mock('@/lib/app-runner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDataSystem: async <T>(fn: () => Promise<T>) => fn(),
  memberDbBroker: vi.fn(async () => {
    h.member += 1;
    return Response.json({ ok: true, columns: [], rows: [] });
  }),
}));

const { POST } = await import('./route');

const query = () =>
  POST(
    new Request('http://brain.invalid/api/apps/a1/db-broker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'query', sql: 'select 1', params: [] }),
    }),
    { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
  );

const BUILD = { ok: true, hash: 'h', at: 'now' };

beforeEach(() => {
  h.ran = 0;
  h.admin = true;
  h.member = 0;
});

describe("an agent-edited draft's build reaches no data", () => {
  it('refused before any SQL, in the broker refusal shape', async () => {
    h.runtime = { id: 'a1', manifest: {}, draftBuild: BUILD, draftAgentEdited: true };
    const res = await query();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe('agent_edited_draft');
    expect(body.error).toContain('save the draft yourself');
    expect(h.ran).toBe(0);
  });

  it('a draft a person saved, or the published build, runs its query', async () => {
    for (const rt of [
      { id: 'a1', manifest: {}, draftBuild: BUILD, draftAgentEdited: false },
      { id: 'a1', manifest: {}, draftBuild: null, draftAgentEdited: true },
      { id: 'a1', manifest: {}, draftBuild: { ...BUILD, ok: false }, draftAgentEdited: true },
    ]) {
      h.runtime = rt;
      const res = await query();
      expect(res.status, JSON.stringify(rt)).not.toBe(403);
    }
    expect(h.ran).toBe(3);
  });

  it("a member's run (the published build) is not touched while the mark is set", async () => {
    h.admin = false;
    h.runtime = { id: 'a1', manifest: {}, draftBuild: BUILD, draftAgentEdited: true };
    expect((await query()).status).toBe(200);
    expect(h.member).toBe(1);
    expect(h.ran).toBe(0);
  });
});

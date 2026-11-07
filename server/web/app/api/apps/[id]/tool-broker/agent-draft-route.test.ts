/**
 * POST /api/apps/:id/tool-broker and a draft an in-app agent saved last
 * (docs/agent-ui.md, migration 0365): an Admin user's run is the draft's
 * build, and while the draft is marked agent-edited no call reaches the
 * broker, tagged or not; once a person saved it (the mark cleared), or with
 * no draft build (the published one runs), the broker runs as before. No
 * database: the login, the runtime row and the broker are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CALL_HEADER } from '@mantle/client-types/agent-ui';

const h = vi.hoisted(() => ({
  runtime: null as Record<string, unknown> | null,
  brokered: 0,
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
  adminFacts: vi.fn(async () => ({ admin: true, areas: new Set() })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async () => h.runtime),
}));
vi.mock('@/lib/app-tool-broker', () => ({
  runAppToolBroker: vi.fn(async (_req: Request, o: { app: () => Promise<unknown> }) => {
    h.brokered += 1;
    await o.app();
    return Response.json({ ok: true });
  }),
}));

const { POST } = await import('./route');

const call = (tagged: boolean) =>
  POST(
    new Request('http://brain.invalid/api/apps/a1/tool-broker', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(tagged ? { [AGENT_CALL_HEADER]: 'x' } : {}),
      },
      body: JSON.stringify({ tool: 'page_get', args: {} }),
    }),
    { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
  );

const BUILD = { hash: 'h', at: 'now' };

beforeEach(() => {
  h.brokered = 0;
});

describe("an agent-edited draft's build calls no tool", () => {
  it('refused, tagged or not, with a plain reason; the broker is never reached', async () => {
    h.runtime = { id: 'a1', draftBuild: BUILD, draftAgentEdited: true };
    for (const tagged of [true, false]) {
      const res = await call(tagged);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.reason).toBe('agent_edited_draft');
      expect(body.error).toContain('save the draft yourself');
    }
    expect(h.brokered).toBe(0);
  });

  it('a draft a person saved (the mark cleared) runs as before', async () => {
    h.runtime = { id: 'a1', draftBuild: BUILD, draftAgentEdited: false };
    expect((await call(false)).status).toBe(200);
    expect(h.brokered).toBe(1);
  });

  it('no draft build: the published build runs as before, whatever the mark', async () => {
    h.runtime = { id: 'a1', draftBuild: null, draftAgentEdited: true };
    expect((await call(false)).status).toBe(200);
    expect(h.brokered).toBe(1);
  });
});

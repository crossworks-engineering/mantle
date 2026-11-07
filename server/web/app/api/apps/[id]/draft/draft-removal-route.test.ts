/**
 * PUT /api/apps/:id/draft, an agent-driven save (docs/agent-ui.md): a save
 * tagged with x-mantle-agent-call never removes a file of the working tree,
 * 403 agent_refused (delete), the person's step; the same save untagged
 * goes through. No database: the right check and the save are stood in,
 * the save's own removal rule in its content test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CALL_HEADER } from '@mantle/client-types/agent-ui';

const h = vi.hoisted(() => ({
  asked: [] as Array<Record<string, unknown>>,
  answer: { draftUpdatedAt: 'now' } as unknown,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-1', actor: { id: 'l1' } }),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertItemRight: vi.fn(async () => undefined),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveDraftSource: vi.fn(
    async (_o: string, _id: string, _s: unknown, opts: Record<string, unknown>) => {
      h.asked.push(opts);
      return opts.refuseRemovals ? h.answer : { draftUpdatedAt: 'now' };
    },
  ),
}));

const { PUT } = await import('./route');

const put = (tagged: boolean) =>
  PUT(
    new Request('http://brain.invalid/api/apps/a1/draft', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(tagged ? { [AGENT_CALL_HEADER]: 'lesson:x' } : {}),
      },
      body: JSON.stringify({ entry: 'index.tsx', files: { 'index.tsx': 'x' } }),
    }),
    { params: Promise.resolve({ id: 'a1' }) },
  );

beforeEach(() => {
  h.asked = [];
  h.answer = { draftUpdatedAt: 'now' };
});

describe('an agent-driven app draft save', () => {
  it('that removes a file: 403 agent_refused (delete)', async () => {
    h.answer = 'removes_files';
    const res = await put(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'agent_refused', reason: 'delete' });
    expect(h.asked).toEqual([{ refuseRemovals: true, agentEdited: true }]);
  });

  it('that keeps every file: saved, and the draft marked agent-edited', async () => {
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(h.asked).toEqual([{ refuseRemovals: true, agentEdited: true }]);
  });

  it("untagged: no removal rule, saved, and the agent's mark cleared (no agentEdited)", async () => {
    const res = await put(false);
    expect(res.status).toBe(200);
    expect(h.asked).toEqual([{}]);
  });
});

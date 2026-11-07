/**
 * PATCH /api/pending/:id, without a database: what the person's decision hands
 * the settle layer. Since no MCP tool approves, this is the one way a form's
 * answers reach a run. A plain yes stays a plain yes: an empty list and an
 * empty answer are not forwarded, or every yes would be a form submission.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '00000000-0000-4000-8000-0000000000aa';
const ROW = '11111111-2222-4333-8444-555555555555';

const h = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id', actor: { id: LOGIN, isOwner: false } }),
}));
vi.mock('@mantle/tools', () => ({
  approvePendingCall: h.approve,
  rejectPendingCall: h.reject,
  getPendingCall: vi.fn(),
}));

import { PATCH } from './route';

const patch = (body: unknown, id = ROW) =>
  PATCH(
    new Request(`http://local/api/pending/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.approve.mockResolvedValue({ id: ROW, status: 'approved' });
  h.reject.mockResolvedValue({ id: ROW, status: 'rejected' });
});

describe('PATCH /api/pending/:id', () => {
  it('forwards structured answers, with who approves', async () => {
    const answers = [{ question: 'env', selected: ['prod'], other: 'and staging' }];
    const res = await patch({ decision: 'approve', answers });
    expect(res.status).toBe(200);
    expect(h.approve).toHaveBeenCalledWith('owner-id', ROW, { answers, approverLoginId: LOGIN });
  });

  it('forwards a free-text answer', async () => {
    await patch({ decision: 'approve', answer: 'after 22:00' });
    expect(h.approve).toHaveBeenCalledWith('owner-id', ROW, {
      answer: 'after 22:00',
      approverLoginId: LOGIN,
    });
  });

  it('a plain yes stays a plain yes: empty answers are not forwarded', async () => {
    for (const body of [
      { decision: 'approve' },
      { decision: 'approve', answers: [] },
      { decision: 'approve', answer: '' },
    ]) {
      await patch(body);
      expect(h.approve).toHaveBeenLastCalledWith('owner-id', ROW, { approverLoginId: LOGIN });
    }
  });

  it('a rejection takes no answers', async () => {
    await patch({ decision: 'reject', answers: [{ question: 'env', selected: ['prod'] }] });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.reject).toHaveBeenCalledWith('owner-id', ROW, LOGIN);
  });

  it('refuses a malformed answer, naming the field, and decides nothing', async () => {
    const res = await patch({ decision: 'approve', answers: [{ question: '', selected: [] }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('answers.0.question'),
    });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('a row missing or already decided is the 404, not a second approval', async () => {
    h.approve.mockResolvedValue(null);
    const res = await patch({ decision: 'approve' });
    expect(res.status).toBe(404);
  });
});

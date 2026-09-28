/**
 * Audit F14 through the routes, without a database: a NUL (U+0000) pasted
 * into a member's page or note, or an admin's private page, reaches the
 * content layer stripped instead of failing in Postgres with a 500. The
 * content layer is stubbed; the routes' parsing is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SPACE = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: '22222222-2222-4222-8222-222222222222',
    anchorId: '33333333-3333-4333-8333-333333333333',
    spaceId: SPACE,
    email: 'pat@example.invalid',
    displayName: 'Pat',
    contactId: null,
  })),
}));
vi.mock('@/lib/admin-space', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAdminSpaceOr401: vi.fn(async () => ({ spaceId: SPACE, loginId: 'admin-1' })),
  inAdminSpace: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSpace: (_s: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertEditable: vi.fn(async () => ({ type: 'page' })),
  // Not taken over by an admin (the with-admin guard reads the database).
  isWithAdmin: vi.fn(async () => false),
  saveDraft: vi.fn(async () => ({ ok: true, rev: 2 })),
  updateMineItem: vi.fn(async () => ({ id: ITEM })),
}));

import { saveDraft, updateMineItem } from '@mantle/content';

const call = (method: string, body: string) =>
  new Request(`http://x/api/member/space/${ITEM}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
const params = { params: Promise.resolve({ id: ITEM }) };
// JSON text carrying an escaped NUL, as a client serializes one.
const DOC = '{"doc":{"type":"doc","content":[{"type":"text","text":"a\\u0000b"}]}}';

beforeEach(() => vi.clearAllMocks());

describe('NUL in a member or admin write', () => {
  it('member draft PUT saves the doc without the NUL', async () => {
    const { PUT } = await import('./[id]/draft/route');
    const res = await PUT(call('PUT', DOC), params);
    expect(res.status).toBe(200);
    const doc = vi.mocked(saveDraft).mock.calls[0]![2] as { content: { text: string }[] };
    expect(doc.content[0]!.text).toBe('ab');
  });

  it('member note PATCH saves the text without the NUL', async () => {
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      call('PATCH', '{"content":"line\\u0000one","title":"t\\u0000"}'),
      params,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(updateMineItem).mock.calls[0]![2]).toEqual({ content: 'lineone', title: 't' });
  });

  it('admin private draft PUT saves the doc without the NUL', async () => {
    const { PUT } = await import('../../admin/space/[id]/draft/route');
    const res = await PUT(call('PUT', DOC), params);
    expect(res.status).toBe(200);
    const doc = vi.mocked(saveDraft).mock.calls[0]![2] as { content: { text: string }[] };
    expect(doc.content[0]!.text).toBe('ab');
  });
});

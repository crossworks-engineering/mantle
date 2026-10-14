/**
 * GET /api/member/realtime (workspaces W8d): the stream an older app opens
 * still opens for a member and keeps alive, and it carries no event (the
 * personal-item feed went with personal spaces). No database; the route and
 * the SSE stream are the real code.
 */
import { describe, expect, it, vi } from 'vitest';

const member = vi.hoisted(() => () => ({
  role: 'member',
  loginId: '22222222-2222-4222-8222-222222222222',
  anchorId: '33333333-3333-4333-8333-333333333333',
  email: 'pat@example.invalid',
  displayName: 'Pat',
  contactId: null,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => member()),
  // The reader the converted handler calls (A4 step 3b part 5): the same
  // stand-in.
  memberCaller: vi.fn(() => member()),
  memberLoginActive: vi.fn(async () => true),
  sessionCookieExpiryMs: vi.fn(async () => null),
}));

describe('GET /api/member/realtime', () => {
  it('opens an event stream for a member that carries no event', async () => {
    const { GET } = await import('./route');
    const ac = new AbortController();
    const res = await GET(new Request('http://x/api/member/realtime', { signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toBe(': connected\n\n');
    expect(text).not.toContain('data:');
    await reader.cancel();
    ac.abort();
  });
});

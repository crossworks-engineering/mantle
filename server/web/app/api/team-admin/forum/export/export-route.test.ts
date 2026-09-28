/**
 * The admin Forum archive route (member logins, Phase 6) without a database:
 * the export is stood in, so these pin the contract the client's Export
 * button builds on. A member login is refused by the gate (proven for every
 * route in server/member-sweep.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  result: null as unknown,
  owners: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countUnexportedForumTopics: vi.fn(async (ownerId: string) => {
    h.owners.push(ownerId);
    return 4;
  }),
  exportForumArchive: vi.fn(async (ownerId: string) => {
    h.owners.push(ownerId);
    return h.result;
  }),
}));

const DONE = {
  status: 'done',
  exported: 2,
  deferred: 1,
  alreadyExported: 0,
  archivePageId: 'p1',
  dumpFileId: 'f1',
  uploadsFiled: 1,
  uploadsMissing: 0,
  tasksLinked: 1,
};

beforeEach(() => {
  h.result = DONE;
  h.owners = [];
});

describe('/api/team-admin/forum/export', () => {
  it('GET answers the unexported count for this brain', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unexported: 4 });
    expect(h.owners).toEqual([ANCHOR]);
  });

  it('POST runs the export and answers its result', async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DONE);
    expect(h.owners).toEqual([ANCHOR]);
  });

  it('POST answers 409 busy while another run holds the lock', async () => {
    h.result = { status: 'busy' };
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason?: string }).reason).toBe('busy');
  });
});

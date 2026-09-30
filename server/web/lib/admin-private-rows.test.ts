/**
 * The admin brain lists with the caller's own private items (item-list
 * alignment), without a database: the brain lists and the admin's space are
 * stood in, so these pin what the ROUTES do with `?state=`. `brain` is the
 * default and reads no private item at all; `all` merges them in the list's
 * own order, read in the ACTING login's own space; a tag filter, a sub-page
 * level or a files folder other than the root lists none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const h = vi.hoisted(() => ({
  mine: [] as Array<{ spaceId: string; opts: Record<string, unknown> }>,
  spaces: [] as unknown[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'a@example.invalid',
    actor: { id: ACTOR, email: 'a@example.invalid', isOwner: false },
  })),
}));

vi.mock('@/lib/auth/login-row', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersonalSpaceId: vi.fn(async (login: string) => (login === ACTOR ? SPACE : null)),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSpace: vi.fn(async (scope: unknown, fn: () => Promise<unknown>) => {
    h.spaces.push(scope);
    return fn();
  }),
}));

const priv = (id: string, title: string, n: number, type = 'page') => ({
  id,
  type,
  title,
  icon: null,
  sharing: 'private',
  reviewState: 'draft',
  submittedAt: null,
  returnedNote: null,
  authorLoginId: ACTOR,
  createdAt: at(n),
  updatedAt: at(n),
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMine: vi.fn(async (spaceId: string, opts: Record<string, unknown>) => {
    h.mine.push({ spaceId, opts });
    const kind = opts.kind as string;
    const rows =
      kind === 'file'
        ? [priv('pf', 'b-private.txt', 25, 'file')]
        : [priv('p1', 'Mid private', 15, kind)];
    return { items: rows, total: rows.length };
  }),
  takenFromOf: vi.fn(async () => new Map()),
}));

const brainPage = (id: string, n: number) => ({
  id,
  parentId: null,
  title: id,
  icon: null,
  tags: [],
  summary: null,
  audience: 'admin',
  createdAt: at(n),
  updatedAt: at(n),
});

vi.mock('@/lib/pages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPages: vi.fn(async () => [brainPage('new', 20), brainPage('old', 10)]),
  countPages: vi.fn(async () => 2),
  listPageTags: vi.fn(async () => []),
}));

vi.mock('@/lib/notes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listNotes: vi.fn(async () => [{ ...brainPage('note', 20), content: '' }]),
  countNotes: vi.fn(async () => 1),
  listNoteTags: vi.fn(async () => []),
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFilesRootBranch: vi.fn(async () => ({})),
  listFiles: vi.fn(async () => [
    { id: 'fa', filename: 'a.txt', title: 'a.txt', updatedAt: at(30), createdAt: at(1) },
    { id: 'fc', filename: 'c.txt', title: 'c.txt', updatedAt: at(5), createdAt: at(1) },
  ]),
  listRecentFiles: vi.fn(async () => [
    { id: 'fa', filename: 'a.txt', title: 'a.txt', updatedAt: at(30), createdAt: at(1) },
    { id: 'fc', filename: 'c.txt', title: 'c.txt', updatedAt: at(5), createdAt: at(1) },
  ]),
}));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

beforeEach(() => {
  h.mine = [];
  h.spaces = [];
});

describe('GET /api/pages with ?state=', () => {
  const get = async (qs: string) => {
    const { GET } = await import('../app/api/pages/route');
    return (await GET(new Request(`http://x/api/pages${qs}`))).json();
  };

  it('lists the brain only by default, reading no private item', async () => {
    const body = await get('');
    expect(ids(body.pages)).toEqual(['new', 'old']);
    expect(h.mine).toEqual([]);
    expect(body.pages.some((p: object) => 'private' in p)).toBe(false);
  });

  it('adds the private pages at the top level of the tree, from the actor’s own space', async () => {
    const body = await get('?state=all');
    expect(ids(body.pages)).toEqual(['new', 'old', 'p1']);
    const p1 = body.pages[2];
    expect(p1).toMatchObject({ id: 'p1', private: { id: 'p1', sharing: 'private' } });
    expect(h.spaces).toEqual([{ spaceId: SPACE, loginId: ACTOR }]);
    expect(h.mine[0]).toMatchObject({ spaceId: SPACE, opts: { kind: 'page' } });
  });

  it('merges them in the sort order when filtering, and lists none under a tag', async () => {
    const body = await get('?state=all&q=x');
    expect(body.mode).toBe('list');
    expect(ids(body.pages)).toEqual(['new', 'p1', 'old']);
    expect(body.total).toBe(3);
    expect(h.mine[0]!.opts).toMatchObject({ q: 'x', sort: 'edited' });
    const tagged = await get('?state=all&tag=t');
    expect(ids(tagged.pages)).toEqual(['new', 'old']);
  });

  it('lists the private pages alone for state=private', async () => {
    expect(ids((await get('?state=private')).pages)).toEqual(['p1']);
    expect(ids((await get('?state=private&q=x')).pages)).toEqual(['p1']);
  });
});

describe('GET /api/notes with ?state=', () => {
  it('merges the private notes newest first', async () => {
    const { GET } = await import('../app/api/notes/route');
    const plain = await (await GET(new Request('http://x/api/notes'))).json();
    expect(ids(plain.notes)).toEqual(['note']);
    const all = await (await GET(new Request('http://x/api/notes?state=all'))).json();
    expect(ids(all.notes)).toEqual(['note', 'p1']);
    expect(all.total).toBe(2);
  });
});

describe('GET /api/files/files with ?state=', () => {
  const get = async (qs: string) => {
    const { GET } = await import('../app/api/files/files/route');
    return (await GET(new Request(`http://x/api/files/files?${qs}`))).json();
  };

  it('adds the private files to the root folder by name, and to no other folder', async () => {
    expect(ids((await get('parent=files')).files)).toEqual(['fa', 'fc']);
    expect(ids((await get('parent=files&state=all')).files)).toEqual(['fa', 'pf', 'fc']);
    expect(ids((await get('parent=files.sub&state=all')).files)).toEqual(['fa', 'fc']);
  });

  it('adds them to Recent by time', async () => {
    expect(ids((await get('recent=1&state=all')).files)).toEqual(['fa', 'pf', 'fc']);
    expect(ids((await get('recent=1&state=private')).files)).toEqual(['pf']);
  });
});

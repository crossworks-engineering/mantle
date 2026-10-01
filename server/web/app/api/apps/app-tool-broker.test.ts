/**
 * The OWNER's app tool broker (client tier audit 2026-09-30, L1): an admin's
 * run of a CLIENT-level app keeps the client rules, because every client
 * reads that app's database; any other app keeps the owner's rules. The level rule (appToolLevel,
 * appToolScope) is the real one; the verdict records the level it was asked
 * at, and at client level and at none the REAL rules answer (they refuse
 * before any lookup). No database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const APP = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  audience: 'admin',
  toolSlugs: ['contact_list'] as string[],
  levels: [] as string[],
  dispatched: [] as Array<{ level: string; ctx: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'jo@example.invalid',
    actor: { id: ACTOR, email: 'jo@example.invalid', displayName: 'Jo', isOwner: true },
  })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApp: vi.fn(async (_owner: string, id: string) =>
    id === APP ? { id, audience: h.audience, manifest: { toolSlugs: h.toolSlugs } } : null,
  ),
}));
vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  const { currentViewerLevel } = await import('@mantle/db');
  return {
    ...real,
    appToolVerdict: vi.fn(
      async (level: string, owner: string, declared: string[], slug: string) => {
        h.levels.push(level);
        if (level === 'client' || level === 'none') {
          return real.appToolVerdict(level, owner, declared, slug);
        }
        return declared.includes(slug)
          ? { ok: true, tool: { slug } }
          : { ok: false, status: 403, reason: 'not declared' };
      },
    ),
    dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: Record<string, unknown>) => {
      h.dispatched.push({ level: currentViewerLevel(), ctx });
      return { ok: true, output: [] };
    }),
  };
});

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let broker: Handler;
const call = (slug: string) =>
  broker(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ slug }) }), {
    params: Promise.resolve({ id: APP }),
  });

beforeAll(async () => {
  broker = (await import('./[id]/tool-broker/route')).POST;
}, 60_000);

beforeEach(() => {
  h.audience = 'admin';
  h.toolSlugs = ['contact_list'];
  h.levels.length = 0;
  h.dispatched.length = 0;
});

describe('owner app tool broker: client rules on a client app, owner rules elsewhere', () => {
  it('an admin-level app runs a declared tool with the owner auth, as always', async () => {
    const res = await call('contact_list');
    expect(res.status).toBe(200);
    expect(h.levels).toEqual(['admin']);
    expect(h.dispatched[0]).toMatchObject({
      level: 'admin',
      ctx: { ownerId: ANCHOR, surface: { kind: 'web' } },
    });
  });

  it('a client-level app refuses contact_list and page_get for an admin too', async () => {
    h.audience = 'client';
    h.toolSlugs = ['contact_list', 'page_get'];
    for (const slug of h.toolSlugs) {
      const res = await call(slug);
      expect(res.status, slug).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/client apps/);
    }
    expect(h.levels).toEqual(['client', 'client']);
    expect(h.dispatched).toHaveLength(0);
  });

  it('a team or public app keeps the owner rules (team apps call MCP and recipe tools)', async () => {
    for (const audience of ['team', 'public']) {
      h.audience = audience;
      h.levels.length = 0;
      h.dispatched.length = 0;
      const res = await call('contact_list');
      expect(res.status, audience).toBe(200);
      expect(h.levels).toEqual(['admin']);
      expect(h.dispatched[0]).toMatchObject({
        level: 'admin',
        ctx: { ownerId: ANCHOR, surface: { kind: 'web' } },
      });
    }
  });
});

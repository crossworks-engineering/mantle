/**
 * The MCP tool `screenshots` (docs/files.md, "Screenshots"): a read, in the
 * Files key area as file_read is, listed for every login kind that lists
 * file_read. With no id the newest screenshots the caller reads; with an id
 * that one's metadata and the picture as an MCP image block, refused when it
 * is no screenshot (or one the caller cannot read: the same answer), over
 * the 5 MB image cap, or no longer a PNG.
 *
 * The reads are stood in (they run on the caller's db handle; the scope is
 * the gate's). The scope entry is stood in too, and records that every
 * read ran inside the calling login's scope, never outside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({
  /** The login whose scope is entered now (null: none). */
  inScope: null as string | null,
  listed: [] as Array<Record<string, unknown> & { scope: string | null }>,
  byId: [] as Array<Record<string, unknown> & { scope: string | null }>,
  reads: [] as Array<{ fileId: string; scope: string | null }>,
  shot: null as null | { file: Record<string, unknown>; meta: Record<string, unknown> },
  bytes: Buffer.alloc(0),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withViewer: vi.fn(async (_level: unknown, _for: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./mcp-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpScopeEntry:
    (loginId: string) =>
    async <T>(_writes: boolean, fn: () => Promise<T>) => {
      const was = h.inScope;
      h.inScope = loginId;
      try {
        return await fn();
      } finally {
        h.inScope = was;
      }
    },
  mcpAdminView: async () => null,
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listScreenshots: async (args: Record<string, unknown>) => {
    h.listed.push({ ...args, scope: h.inScope });
    return [{ id: ID, filename: 'screenshot-2026-11-06-101507.png', sizeBytes: 12 }];
  },
  screenshotById: async (args: Record<string, unknown>) => {
    h.byId.push({ ...args, scope: h.inScope });
    return h.shot;
  },
  readFileById: async (args: { fileId: string }) => {
    h.reads.push({ fileId: args.fileId, scope: h.inScope });
    return { row: h.shot?.file, bytes: h.bytes, path: null };
  },
}));

import { registerMantleTools } from './build-server';
import { keyAreasAllowTool, mcpToolPolicyOf, toolKeyArea } from './mcp-policy';
import {
  mcpDefinition,
  SCREENSHOT_IMAGE_MAX_BYTES,
  SCREENSHOTS_LIST_DEFAULT,
  SCREENSHOTS_LIST_MAX,
} from './mcp-defs';
import {
  preparedLists,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import { SCOPE_AREAS } from '@mantle/db/viewer';

type Reply = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Reply>;

const ID = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const shotOf = (sizeBytes: number) => ({
  file: { id: ID, filename: 'screenshot-2026-11-06-101507.png', mimeType: 'image/png', sizeBytes },
  meta: { screen: 'Files', route: '/files', capturedAt: '2026-11-06T10:15:07.000Z' },
});

function surface(caller?: McpCaller, view = { holdsAdmin: true, areas: new Set(SCOPE_AREAS) }) {
  const out = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
  };
  if (!caller) registerMantleTools(fake as never, 'anchor', { transport: 'http' });
  else {
    const prepared: PreparedCallerTools = {
      kind: 'owner',
      caller,
      view,
      privateWs: null,
      connectors: [],
    };
    registerPreparedTools(fake as never, prepared);
  }
  return out;
}

const key = (areas: string[] | null): McpCaller => ({
  role: 'admin',
  anchorId: 'anchor',
  loginId: 'anchor',
  via: 'key',
  write: false,
  areas,
});

beforeEach(() => {
  h.inScope = null;
  h.listed.length = 0;
  h.byId.length = 0;
  h.reads.length = 0;
  h.shot = shotOf(PNG.length);
  h.bytes = PNG;
});

describe('screenshots: its policy and who has it', () => {
  it('a read in the Files area, open to any scope, like file_read', () => {
    const p = mcpToolPolicyOf('screenshots')!;
    expect(p).toMatchObject({
      effect: 'read',
      spends: 'none',
      scope: 'any',
      keyArea: 'files',
      peerRisky: true,
    });
    expect(toolKeyArea('screenshots')).toBe(toolKeyArea('file_read'));
  });

  it('a key without the Files area does not have it; one with it does', () => {
    expect(keyAreasAllowTool('screenshots', null)).toBe(true);
    expect(keyAreasAllowTool('screenshots', ['files'])).toBe(true);
    for (const areas of [['pages'], ['search'], ['pages', 'notes', 'tables', 'search']]) {
      expect(keyAreasAllowTool('screenshots', areas), areas.join()).toBe(false);
      expect(keyAreasAllowTool('file_read', areas), areas.join()).toBe(false);
    }
    expect(
      preparedLists(
        {
          kind: 'owner',
          caller: key(['pages']),
          view: { holdsAdmin: true, areas: new Set(SCOPE_AREAS) },
          privateWs: null,
          connectors: [],
        },
        'screenshots',
      ),
    ).toBe(false);
    expect(surface(key(['pages'])).has('screenshots')).toBe(false);
    // Peer-risky: a key with the Files area has it only when the owner
    // named it on the key.
    expect(surface(key(['files'])).has('screenshots')).toBe(false);
    expect(surface({ ...key(['files']), riskyAllowed: ['screenshots'] }).has('screenshots')).toBe(
      true,
    );
    expect(surface({ ...key(null), riskyAllowed: ['screenshots'] }).has('screenshots')).toBe(true);
    expect(surface(key(null)).has('screenshots')).toBe(false);
  });

  it('peer-risky: a key or a linked brain bound to a login calls it only when named', () => {
    expect(mcpToolPolicyOf('screenshots')).toMatchObject({ peerRisky: true });
  });

  it('a member login lists it, as it lists file_read', () => {
    const out = surface(
      { role: 'member', anchorId: 'anchor', loginId: MEMBER, via: 'oauth', write: true },
      { holdsAdmin: false, areas: new Set() },
    );
    expect(out.has('file_read')).toBe(true);
    expect(out.has('screenshots')).toBe(true);
  });

  it('its arguments: an optional uuid id, a limit of 1 to 50', () => {
    const shape = mcpDefinition('screenshots')!.shape;
    expect(Object.keys(shape).sort()).toEqual(['id', 'limit']);
    const args = z.object(shape);
    const ok = (a: Record<string, unknown>) => args.safeParse(a).success;
    expect(ok({})).toBe(true);
    expect(ok({ id: ID })).toBe(true);
    expect(ok({ id: 'nope' })).toBe(false);
    expect(ok({ limit: SCREENSHOTS_LIST_MAX })).toBe(true);
    expect(ok({ limit: SCREENSHOTS_LIST_MAX + 1 })).toBe(false);
    expect(ok({ limit: 0 })).toBe(false);
    expect(SCREENSHOTS_LIST_DEFAULT).toBe(10);
    expect(SCREENSHOTS_LIST_MAX).toBe(50);
  });
});

describe('screenshots: the calls', () => {
  it('no id: the newest, 10 by default, read in the calling login scope', async () => {
    const tool = surface().get('screenshots')!;
    const reply = await tool({});
    expect(reply.isError).toBeUndefined();
    expect(JSON.parse(reply.content[0]!.text!)).toEqual({
      screenshots: [{ id: ID, filename: 'screenshot-2026-11-06-101507.png', sizeBytes: 12 }],
    });
    await tool({ limit: 3 });
    expect(h.listed).toEqual([
      { ownerId: 'anchor', limit: 10, scope: 'anchor' },
      { ownerId: 'anchor', limit: 3, scope: 'anchor' },
    ]);
  });

  it("a member's call reads in the member's scope, never the owner's", async () => {
    const tool = surface(
      { role: 'member', anchorId: 'anchor', loginId: MEMBER, via: 'oauth', write: true },
      { holdsAdmin: false, areas: new Set() },
    ).get('screenshots')!;
    await tool({});
    await tool({ id: ID });
    expect(h.listed.map((c) => c.scope)).toEqual([MEMBER]);
    expect(h.byId.map((c) => c.scope)).toEqual([MEMBER]);
    // Row security alone, as file_list: no login named in the reads.
    expect(h.listed.every((c) => !('loginId' in c))).toBe(true);
    expect(h.byId.every((c) => !('loginId' in c))).toBe(true);
    expect(h.reads.map((c) => c.scope)).toEqual([MEMBER]);
  });

  it("a peer bound to an Admin user the owner did not register: the reads run in that login's scope, not the owner's", async () => {
    const ADMIN_Y = '33333333-3333-4333-8333-333333333333';
    const peer: McpCaller = {
      role: 'admin',
      anchorId: 'anchor',
      loginId: ADMIN_Y,
      via: 'peer',
      write: false,
      peerId: 'peer-1',
      riskyAllowed: ['screenshots'],
    };
    const tool = surface(peer).get('screenshots')!;
    await tool({});
    await tool({ id: ID });
    expect(h.listed).toEqual([
      { ownerId: 'anchor', limit: SCREENSHOTS_LIST_DEFAULT, scope: ADMIN_Y },
    ]);
    expect(h.byId).toEqual([{ ownerId: 'anchor', id: ID, scope: ADMIN_Y }]);
  });

  it('an id: the metadata as JSON, then the picture as an image block', async () => {
    const reply = await surface().get('screenshots')!({ id: ID });
    expect(reply.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(JSON.parse(reply.content[0]!.text!)).toEqual({
      screenshot: {
        screen: 'Files',
        route: '/files',
        capturedAt: '2026-11-06T10:15:07.000Z',
        id: ID,
        filename: 'screenshot-2026-11-06-101507.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
      },
    });
    expect(reply.content[1]!.mimeType).toBe('image/png');
    expect(Buffer.from(reply.content[1]!.data!, 'base64').equals(PNG)).toBe(true);
  });

  it('no screenshot (or one the caller cannot read): refused, nothing read from disk', async () => {
    h.shot = null;
    const reply = await surface().get('screenshots')!({ id: ID });
    expect(reply.isError).toBe(true);
    expect(reply.content).toEqual([{ type: 'text', text: 'screenshot not found' }]);
    expect(h.reads).toEqual([]);
  });

  it('over the image cap by its size: refused before the read', async () => {
    h.shot = shotOf(SCREENSHOT_IMAGE_MAX_BYTES + 1);
    const reply = await surface().get('screenshots')!({ id: ID });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toMatch(/larger than 5 MB/);
    expect(h.reads).toEqual([]);
  });

  it('over the image cap by its bytes, or no longer a PNG: refused, no image', async () => {
    h.bytes = Buffer.concat([PNG, Buffer.alloc(SCREENSHOT_IMAGE_MAX_BYTES)]);
    const big = await surface().get('screenshots')!({ id: ID });
    expect(big.isError).toBe(true);
    expect(big.content.map((c) => c.type)).toEqual(['text']);
    h.bytes = Buffer.from('not a png at all');
    const replaced = await surface().get('screenshots')!({ id: ID });
    expect(replaced.isError).toBe(true);
    expect(replaced.content[0]!.text).toMatch(/no longer a PNG/);
  });
});

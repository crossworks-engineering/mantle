/**
 * draw_get's picture on MCP. The picture is an option on `draw_get`, not a
 * tool of its own, so every rule that decides who may call `draw_get`
 * decides who may get the picture, with nothing to keep in step. Pinned here:
 *
 *  - the owner gets an MCP image block after the JSON (text only unless
 *    asked);
 *  - an API key reaches it only with every area (draw_get is in no key area),
 *    so a key limited to areas, the one the email-attachment guard is for,
 *    never gets it;
 *  - a peer bound to the owner gets it read-only (draw_get only reads);
 *  - a member's call runs through the login path with the member stamped on
 *    the surface (their image rule), and comes back with the image block;
 *  - a client never gets draw_get (the client cut).
 *
 * The drawing's reads are stubbed (the DB-backed reader rules are in
 * packages/content/src/draw-reader.viewer.db.test.ts); the renderer is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readableDrawSvg: vi.fn(),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readableDraw: vi.fn(async (_o: string, id: string) => ({
    id,
    title: 'Pipeline',
    tags: [],
    summary: null,
    hasDraft: false,
    hasSvg: true,
  })),
  readableDrawText: vi.fn(async () => 'Ingest -> Extract'),
  readableDrawSvg: h.readableDrawSvg,
}));

vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  return {
    ...real,
    // No database here: the id precondition is the dispatcher's concern.
    checkToolPreconditions: vi.fn(async () => null),
    // The login path's dispatcher, minus the DB-backed preconditions: the
    // real builtin with the context the login path built.
    dispatchTool: vi.fn(
      async (row: { slug: string }, args: Record<string, unknown>, ctx: unknown) =>
        real.getBuiltin(row.slug)!.handler(args, ctx as never),
    ),
  };
});

import type { Tool } from '@mantle/db';
import { CLIENT_TURN_TOOL_SLUGS } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { keyAreasAllowTool } from './key-scope';
import { keyEmailGuard } from './key-email-guard';
import {
  loginMayHaveTool,
  ownerPeerAllows,
  preparedAllows,
  registerLoginRows,
  type McpCaller,
} from './login-surface';

type Reply = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;

const ID = '11111111-1111-4111-8111-111111111111';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect x="10" y="10" width="100" height="50" fill="#1971c2"/></svg>';

function ownerSurface(opts: Parameters<typeof registerMantleTools>[2] = {}): Map<string, Handler> {
  const out = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
  };
  registerMantleTools(fake as never, 'anchor', { transport: 'http', ...opts });
  return out;
}

beforeEach(() => {
  h.readableDrawSvg.mockReset().mockResolvedValue({ snapshot: SVG, visibleFileIds: null });
});

describe('draw_get picture on MCP', () => {
  it('owner: an image block after the JSON when asked, text only otherwise', async () => {
    const drawGet = ownerSurface().get('draw_get')!;
    const plain = await drawGet({ id: ID });
    expect(plain.content.map((c) => c.type)).toEqual(['text']);
    const withImage = await drawGet({ id: ID, image: true });
    expect(withImage.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(withImage.content[1]!.mimeType).toBe('image/png');
    expect(Buffer.from(withImage.content[1]!.data!, 'base64').subarray(0, 4).toString('hex')).toBe(
      '89504e47',
    );
    expect(JSON.parse(withImage.content[0]!.text!).image).toMatchObject({ format: 'png' });
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, { kind: 'scope' });
  });

  it('API key: only an all-areas key has draw_get, so no area key gets the picture', () => {
    expect(keyAreasAllowTool('draw_get', null)).toBe(true);
    for (const areas of [['files'], ['search'], ['pages', 'notes', 'tables', 'files', 'search']]) {
      expect(keyAreasAllowTool('draw_get', areas), areas.join()).toBe(false);
    }
    const key = (areas: string[] | null): McpCaller => ({
      role: 'admin',
      anchorId: 'anchor',
      loginId: 'anchor',
      via: 'key',
      write: false,
      areas,
    });
    expect(preparedAllows({ kind: 'owner', caller: key(null) }, 'draw_get')).toBe(true);
    expect(preparedAllows({ kind: 'owner', caller: key(['files', 'search']) }, 'draw_get')).toBe(
      false,
    );
    const limited = ownerSurface({
      via: 'api',
      allow: (s) => keyAreasAllowTool(s, ['files']),
      guard: keyEmailGuard('anchor'),
    });
    expect(limited.has('draw_get')).toBe(false);
  });

  it('peer bound to the owner: draw_get with its picture, read-only', async () => {
    expect(ownerPeerAllows('draw_get', { write: false })).toBe(true);
    const peer = ownerSurface({
      via: 'federation',
      allow: (s) => ownerPeerAllows(s, { write: false }),
    });
    const reply = await peer.get('draw_get')!({ id: ID, image: true });
    expect(reply.content.map((c) => c.type)).toEqual(['text', 'image']);
  });

  it('member login: the member is stamped on the surface and the image block comes back', async () => {
    const row = {
      slug: 'draw_get',
      handler: { kind: 'builtin', ref: 'draw_get' },
      requiresConfirm: false,
      description: '',
      inputSchema: {},
    } as unknown as Tool;
    expect(loginMayHaveTool(row, false)).toBe(true);
    const out = new Map<string, Handler>();
    const fake = {
      registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
    };
    registerLoginRows(fake as never, {
      kind: 'login',
      caller: {
        role: 'member',
        anchorId: 'anchor',
        loginId: 'member-1',
        via: 'oauth',
        write: false,
      },
      rows: [row],
      level: 'team',
      privateReads: false,
    });
    const reply = await out.get('draw_get')!({ id: ID, image: true });
    expect(reply.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, {
      kind: 'member',
      loginId: 'member-1',
    });
  });

  it('client login: draw_get is cut, so there is no picture to ask for', () => {
    expect(CLIENT_TURN_TOOL_SLUGS).not.toContain('draw_get');
  });
});

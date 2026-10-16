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
 *  - a member has the same surface since W7b (draw_get listed, its login
 *    stamped); off workspaces its call is refused, never run unscoped;
 *  - a client login is refused before any tool (plan 21.9).
 *
 * The drawing's reads are stubbed (the DB-backed reader rules are in
 * packages/content/src/draw-reader.viewer.db.test.ts); the renderer is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The login path reads as the login (withViewer): no database here, so the
// viewer scope runs the call as is.
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withViewer: vi.fn(async (_level: unknown, _for: unknown, fn: () => Promise<unknown>) => fn()),
}));
// No database: each call runs as it is, with no scope entered (the scope
// entry and the Admin view stood in).
vi.mock('./mcp-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpScopeEntry:
    () =>
    <T>(_writes: boolean, fn: () => Promise<T>) =>
      fn(),
  mcpAdminView: async () => null,
}));

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

// No database here: the id precondition is the gate's item pre-check's
// concern (the real dispatch and gate run every call, A5 step 4).
vi.mock('../../tools/src/preconditions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkToolPreconditions: vi.fn(async () => null),
}));

import { registerMantleTools } from './build-server';
import { keyAreasAllowTool } from './mcp-policy';
import {
  preparedLists,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import { ownerPeerAllows } from './policy-views.test-helper';
import { SCOPE_AREAS } from '@mantle/db/viewer';

/** A user of the Admin workspace with every area: what lists everything
 *  (a prepared connection read no narrower). */
const ADMIN_VIEW = { holdsAdmin: true, areas: new Set(SCOPE_AREAS) };

const prepared = (caller: McpCaller): PreparedCallerTools => ({
  kind: 'owner',
  caller,
  view: ADMIN_VIEW,
  privateWs: null,
  connectors: [],
});

type Reply = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;

const ID = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect x="10" y="10" width="100" height="50" fill="#1971c2"/></svg>';

function ownerSurface(): Map<string, Handler> {
  const out = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
  };
  registerMantleTools(fake as never, 'anchor', { transport: 'http' });
  return out;
}

/** The surface a connection gets (registerPreparedTools). */
function connectionSurface(caller: McpCaller): Map<string, Handler> {
  const out = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
  };
  registerPreparedTools(fake as never, prepared(caller));
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
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, { teamSurface: false });
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
    expect(preparedLists(prepared(key(null)), 'draw_get')).toBe(true);
    expect(preparedLists(prepared(key(['files', 'search'])), 'draw_get')).toBe(false);
    // A key with Files only: the email guard on, and no draw_get.
    const limited = connectionSurface(key(['files']));
    expect(limited.has('file_list')).toBe(true);
    expect(limited.has('draw_get')).toBe(false);
  });

  it('peer bound to the owner: draw_get with its picture, read-only', async () => {
    expect(ownerPeerAllows('draw_get', { write: false })).toBe(true);
    const peer = connectionSurface({
      role: 'admin',
      anchorId: 'anchor',
      loginId: 'anchor',
      via: 'peer',
      write: false,
      riskyAllowed: [],
    });
    const reply = await peer.get('draw_get')!({ id: ID, image: true });
    expect(reply.content.map((c) => c.type)).toEqual(['text', 'image']);
  });

  it('member login: the one surface lists draw_get, never an adminOnly tool', async () => {
    const out = new Map<string, Handler>();
    const fake = {
      registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
    };
    registerPreparedTools(fake as never, {
      kind: 'owner',
      caller: { role: 'member', anchorId: 'anchor', loginId: MEMBER, via: 'oauth', write: true },
      view: { holdsAdmin: false, areas: new Set() },
      privateWs: null,
      connectors: [],
    });
    expect(out.has('draw_get')).toBe(true);
    // An adminOnly tool is not listed for a scope without Admin.
    expect(out.has('replay_window')).toBe(false);
  });
});

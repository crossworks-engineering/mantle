/**
 * app_render's rights and what it hands the renderer (tool.ts): the same
 * rights as opening the app. A client, a contact or a turn with no login is
 * refused; an app the caller's scope does not read is not found; an Admin
 * user sees the green draft (else the published build), anyone else the
 * published build only; no green build is refused with what to do. The
 * renderer gets the caller as the app's person, and a bridge answer bound to
 * the call. What the picture says comes back as data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRenderRequest, AppRenderResult } from '../app-render-bridge';

const h = vi.hoisted(() => ({
  app: null as unknown,
  outsideAdmin: false,
  scope: null as unknown,
  peeks: [] as unknown[][],
  answers: [] as unknown[][],
}));

vi.mock('@mantle/db', () => ({
  asSystem: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@mantle/db/viewer', () => ({ currentWorkspaceScope: () => h.scope }));
vi.mock('@mantle/content', () => ({ getAppRuntime: async () => h.app }));
vi.mock('@mantle/content/app-broker', () => ({
  appViewerPeek: async (...args: unknown[]) => {
    h.peeks.push(args);
    return { id: 'u_x', name: 'Pat', kind: (args[2] as { kind: string }).kind };
  },
}));
vi.mock('../outside-admin', () => ({ scopeOutsideAdmin: async () => h.outsideAdmin }));
vi.mock('./host-calls', () => ({
  answerRenderHostCall: async (...args: unknown[]) => {
    h.answers.push(args);
    return { ok: true, output: [] };
  },
}));

import { registerAppRenderer } from '../app-render-bridge';
import { app_render } from './tool';
import type { ToolHandlerContext } from '../types';

const APP = '11111111-2222-4333-8444-555555555555';
const green = (key: string) => ({ storageKey: key, ok: true, css: null });
const red = (key: string) => ({ storageKey: key, ok: false });

const owner = (loginId?: string): ToolHandlerContext =>
  ({
    ownerId: 'owner-1',
    surface: { kind: 'owner', via: 'mcp', ...(loginId ? { loginId } : {}) },
  }) as unknown as ToolHandlerContext;

let seen: AppRenderRequest[] = [];
const picture: AppRenderResult = {
  ok: true,
  png: Buffer.from('png'),
  mime: 'image/png',
  width: 1280,
  height: 800,
  ready: true,
  consoleErrors: ['boom'],
  blocked: ['/api/files/x'],
  refused: ['tool.call file_sql'],
  hostCalls: 3,
};

beforeEach(() => {
  h.app = {
    id: APP,
    title: 'Review log',
    draftBuild: green('draft-key'),
    publishedBuild: green('pub-key'),
  };
  h.outsideAdmin = false;
  h.scope = null;
  h.peeks = [];
  h.answers = [];
  seen = [];
  registerAppRenderer(async (req) => {
    seen.push(req);
    return picture;
  });
});

describe('app_render', () => {
  it('is a read that changes nothing and refuses a client by the gate', () => {
    expect(app_render.policy).toMatchObject({ effect: 'read', spends: 'none' });
    expect(app_render.ownerOnly).toBe(true);
    expect(app_render.loginTurns).toBe(true);
  });

  it('draws the green draft for an Admin user, as that user', async () => {
    const out = await app_render.handler(
      { id: APP, theme: 'dark', width: 390, height: 844 },
      owner('login-1'),
    );
    expect(out).toMatchObject({
      ok: true,
      output: {
        id: APP,
        build: 'draft',
        render: { rendered: true, refused_host_calls: ['tool.call file_sql'] },
      },
      modelImages: [{ mimeType: 'image/png' }],
    });
    expect(seen[0]).toMatchObject({
      build: { storageKey: 'draft-key' },
      viewer: { kind: 'admin', name: 'Pat' },
      width: 390,
      height: 844,
      theme: 'dark',
    });
    expect(h.peeks[0]).toEqual(['owner-1', APP, { kind: 'admin', loginId: 'login-1' }]);
    // The bridge answers as the same person, for this app.
    await seen[0]!.hostCall({ kind: 'db.query', sql: 'SELECT 1' });
    expect(h.answers[0]![0]).toEqual({
      ownerId: 'owner-1',
      appId: APP,
      viewer: { kind: 'admin', loginId: 'login-1' },
      callerKey: 'admin:login-1',
    });
  });

  it('an Admin user with a red draft gets the published build, and says so', async () => {
    h.app = { ...(h.app as object), draftBuild: red('draft-key') };
    const out = await app_render.handler({ id: APP }, owner('login-1'));
    expect(out).toMatchObject({ ok: true, output: { build: 'published' } });
    expect(seen[0]!.build.storageKey).toBe('pub-key');
  });

  it('a member gets the published build only, never the draft', async () => {
    h.outsideAdmin = true;
    const out = await app_render.handler({ id: APP }, owner('login-2'));
    expect(out).toMatchObject({ ok: true, output: { build: 'published' } });
    expect(seen[0]).toMatchObject({ build: { storageKey: 'pub-key' }, viewer: { kind: 'member' } });

    h.app = { ...(h.app as object), publishedBuild: null };
    seen = [];
    const none = await app_render.handler({ id: APP }, owner('login-2'));
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('no published build') });
    expect(seen).toEqual([]);
  });

  it('no green build at all: refused with what to do', async () => {
    h.app = { ...(h.app as object), draftBuild: red('d'), publishedBuild: null };
    const out = await app_render.handler({ id: APP }, owner('login-1'));
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('app_build') });
    expect(seen).toEqual([]);
  });

  it('an app the scope does not read is not found', async () => {
    h.app = null;
    const out = await app_render.handler({ id: APP }, owner('login-1'));
    expect(out.ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it('refuses a client, a contact, a team turn with no login, and a path that names no one', async () => {
    const calls: ToolHandlerContext[] = [
      { ownerId: 'o', surface: { kind: 'client', loginId: 'c' } } as unknown as ToolHandlerContext,
      {
        ownerId: 'o',
        surface: { kind: 'contact', contactId: 'c', shareId: 's' },
      } as unknown as ToolHandlerContext,
      {
        ownerId: 'o',
        surface: { kind: 'team', contactName: 'x' },
      } as unknown as ToolHandlerContext,
      { ownerId: 'o' } as unknown as ToolHandlerContext,
      owner(),
    ];
    for (const ctx of calls) {
      expect((await app_render.handler({ id: APP }, ctx)).ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });

  it("a login's own workspace turn may look, at member rights", async () => {
    h.outsideAdmin = true;
    h.scope = { kind: 'assistant', loginId: 'login-3' };
    const ctx = {
      ownerId: 'owner-1',
      surface: { kind: 'team', loginId: 'login-3', contactName: 'Sam' },
    } as unknown as ToolHandlerContext;
    const out = await app_render.handler({ id: APP }, ctx);
    expect(out).toMatchObject({ ok: true, output: { build: 'published' } });
    expect(seen[0]!.viewer).toMatchObject({ kind: 'member' });
  });

  it('holds the window to the schema bounds and passes a failure as a note', async () => {
    registerAppRenderer(async (req) => {
      seen.push(req);
      return { ok: false, error: 'The browser sidecar is not reachable right now.' };
    });
    const out = await app_render.handler(
      { id: APP, width: 99_999, height: 1, at_seconds: 99 },
      owner('login-1'),
    );
    expect(seen[0]).toMatchObject({ width: 2400, height: 240, atSeconds: 10 });
    expect(out).toMatchObject({
      ok: true,
      output: { render: { rendered: false, note: expect.stringContaining('sidecar') } },
    });
    expect('modelImages' in out).toBe(false);
  });

  it('says so in a process with no renderer', async () => {
    registerAppRenderer(null);
    const out = await app_render.handler({ id: APP }, owner('login-1'));
    expect(out).toMatchObject({ ok: true, output: { render: { rendered: false } } });
  });
});

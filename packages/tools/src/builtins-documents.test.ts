/**
 * The four documents tools: each names its route from its arguments
 * (pdf_render and screenshot_render pick url, html or markdown from what the
 * caller gave; pdf_tools maps `op` to the PDF-engine route), hands the
 * inputs and options through untouched, runs as the acting login (the
 * render cookie), and answers the landed file (or the JSON of a read). A
 * package error is the tool's error text. The policy: a write that makes a
 * file, spends nothing, not mcpOnly, and the config gate names the same
 * four slugs. A team app may call them (policy memberApp 'documents'): no
 * page print, and its file lands only in the workspace that holds the app,
 * for a moderator of it; any app may take the bytes back instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ runDocuments: vi.fn() }));
vi.mock('@mantle/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/documents')>()),
  runDocuments: engine.runDocuments,
}));
const actor = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const scope = vi.hoisted(() => ({
  writes: false,
  ws: null as null | { ws: string[]; modWs: string[] },
  homes: [] as unknown[],
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  currentActor: () => actor.current,
  appRunWriteMode: () => (scope.writes ? 'app' : null),
  currentWorkspaceScope: () => scope.ws,
  withCreateHome: (home: unknown, fn: () => unknown) => {
    scope.homes.push(home);
    return fn();
  },
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tracing')>()),
  recordIngest: vi.fn(),
}));

import { toolService } from '@mantle/config';
import { recordIngest } from '@mantle/tracing';
import { DOCUMENT_TOOLS, PDF_TOOL_OPS, registerDocumentToolServices } from './builtins-documents';
import { APP_BYTES_MAX } from './app-bytes';
import { memberAppRefusal } from './runtime-policy';
import { isBuiltinTeamDocuments } from './registry';
import type { ToolCaller } from './gate-callers';
import type { ToolHandlerContext } from './types';

registerDocumentToolServices();

const by = Object.fromEntries(DOCUMENT_TOOLS.map((t) => [t.slug, t]));
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const LOGIN = '44444444-4444-4444-8444-444444444444';
const FILE = {
  id: 'f1',
  name: 'out.pdf',
  path: 'files.auto_filed.exports/out.pdf',
  sizeBytes: 9,
  mimeType: 'application/pdf',
  landedIn: { id: 'w', name: 'Admin' },
};

beforeEach(() => {
  engine.runDocuments.mockReset();
  engine.runDocuments.mockResolvedValue({ kind: 'file', route: 'r', file: FILE });
  actor.current = { kind: 'login', mode: 'rw', loginId: LOGIN };
  vi.mocked(recordIngest).mockClear();
  scope.writes = false;
  scope.ws = null;
  scope.homes = [];
});

/** A call an app broker made, at `rules`. */
const appCtx = (rules: 'admin' | 'team'): ToolHandlerContext => ({
  ownerId: 'o1',
  caller: { entry: 'app', via: 'app', appRules: rules } as unknown as ToolCaller,
});
const HOLDER = '55555555-5555-4555-8555-555555555555';

describe('the four tools', () => {
  it('need the documents service, are writes that make a file, not mcpOnly', () => {
    expect(DOCUMENT_TOOLS.map((t) => t.slug)).toEqual([
      'pdf_render',
      'screenshot_render',
      'office_to_pdf',
      'pdf_tools',
    ]);
    for (const t of DOCUMENT_TOOLS) {
      expect(toolService(t.slug)).toBe('documents');
      expect(t.policy.effect).toBe('write');
      expect(t.policy.spends).toBe('none');
      expect(t.policy.creates).toBe('file');
      expect(t.mcpOnly).toBeUndefined();
      expect(t.policy.startsModelWork).toBeUndefined();
    }
  });

  it('pdf_render: a node prints through the url route, as the acting login', async () => {
    const out = await by.pdf_render!.handler(
      { node_id: 'n1', options: { landscape: true }, filename: 'plan' },
      ctx,
    );
    expect(out).toEqual({
      ok: true,
      output: {
        route: 'r',
        file_id: 'f1',
        filename: 'out.pdf',
        path: 'files.auto_filed.exports/out.pdf',
        size_bytes: 9,
        mime_type: 'application/pdf',
        landedIn: { id: 'w', name: 'Admin' },
      },
    });
    expect(engine.runDocuments).toHaveBeenCalledWith(
      {
        route: 'chromium/convert/url',
        inputs: { node_id: 'n1' },
        options: { landscape: true },
        filename: 'plan',
      },
      { ownerId: 'o1', actorLoginId: LOGIN },
    );
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'f1',
        payload: expect.objectContaining({ via: 'documents_tool' }),
      }),
    );
  });

  it('pdf_render: html and markdown pick their routes; header and footer ride along', async () => {
    await by.pdf_render!.handler(
      { html: '<h1>x</h1>', header_html: '<p>h</p>', footer_html: '<p>f</p>' },
      ctx,
    );
    expect(engine.runDocuments.mock.calls[0]![0]).toMatchObject({
      route: 'chromium/convert/html',
      inputs: { html: '<h1>x</h1>', header_html: '<p>h</p>', footer_html: '<p>f</p>' },
    });
    await by.pdf_render!.handler({ markdown: '# x', asset_file_ids: ['a'] }, ctx);
    expect(engine.runDocuments.mock.calls[1]![0]).toMatchObject({
      route: 'chromium/convert/markdown',
      inputs: { markdown: '# x', asset_file_ids: ['a'] },
    });
    await by.screenshot_render!.handler({ node_id: 'd1', options: { selector: 'img' } }, ctx);
    expect(engine.runDocuments.mock.calls[2]![0]).toMatchObject({
      route: 'chromium/screenshot/url',
      options: { selector: 'img' },
    });
  });

  it('a call with no login actor converts without a render cookie', async () => {
    actor.current = { kind: 'assistant', agentId: null };
    await by.office_to_pdf!.handler({ file_ids: ['f'] }, ctx);
    expect(engine.runDocuments).toHaveBeenCalledWith(
      {
        route: 'libreoffice/convert',
        inputs: { file_ids: ['f'] },
        options: {},
        filename: undefined,
      },
      { ownerId: 'o1', actorLoginId: null },
    );
  });

  it('pdf_tools: every op maps to its route; a JSON read answers the JSON; an unknown op names the ops', async () => {
    expect(Object.keys(PDF_TOOL_OPS)).toHaveLength(15);
    for (const [op, route] of Object.entries(PDF_TOOL_OPS)) {
      engine.runDocuments.mockClear();
      await by.pdf_tools!.handler({ op, file_ids: ['f'] }, ctx);
      expect(engine.runDocuments.mock.calls[0]![0]).toMatchObject({ route });
    }
    engine.runDocuments.mockResolvedValue({
      kind: 'json',
      route: 'pdfengines/metadata/read',
      json: { 'a.pdf': { PageCount: 2 } },
    });
    expect(await by.pdf_tools!.handler({ op: 'metadata_read', file_ids: ['f'] }, ctx)).toEqual({
      ok: true,
      output: { route: 'pdfengines/metadata/read', result: { 'a.pdf': { PageCount: 2 } } },
    });
    expect(await by.pdf_tools!.handler({ op: 'shred', file_ids: ['f'] }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a PDF tool; the ops are merge, split/),
    });
    expect(
      (by.pdf_tools!.inputSchema.properties as Record<string, { enum: string[] }>).op!.enum,
    ).toEqual(Object.keys(PDF_TOOL_OPS));
  });

  it('a package error is the tool error', async () => {
    engine.runDocuments.mockRejectedValue(new Error('The documents engine is not available: off'));
    expect(await by.pdf_render!.handler({ html: 'x' }, ctx)).toEqual({
      ok: false,
      error: 'The documents engine is not available: off',
    });
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('a team app may call them: policy memberApp documents, let through the team rule', () => {
    for (const t of DOCUMENT_TOOLS) {
      expect(t.policy.memberApp).toBe('documents');
      expect(isBuiltinTeamDocuments(t.slug)).toBe(true);
      expect(
        memberAppRefusal(
          t.slug,
          t.slug,
          { readOnly: false, spends: false, documents: true },
          false,
          () => false,
        ),
      ).toBeNull();
    }
    // Only these four: another write keeps its refusal.
    expect(isBuiltinTeamDocuments('export_node')).toBe(false);
    expect(isBuiltinTeamDocuments('note_create')).toBe(false);
  });

  it('bytes: only for a mini app; nothing saved, the bytes as base64', async () => {
    expect(await by.pdf_render!.handler({ html: 'x', bytes: true }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^bytes is for a mini app/),
    });
    expect(engine.runDocuments).not.toHaveBeenCalled();
    engine.runDocuments.mockResolvedValue({
      kind: 'bytes',
      route: 'chromium/convert/html',
      bytes: Buffer.from('%PDF-1'),
      contentType: 'application/pdf',
      filename: 'document.pdf',
    });
    expect(await by.pdf_render!.handler({ html: 'x', bytes: true }, appCtx('team'))).toEqual({
      ok: true,
      output: {
        route: 'chromium/convert/html',
        filename: 'document.pdf',
        mime_type: 'application/pdf',
        size_bytes: 6,
        content_base64: Buffer.from('%PDF-1').toString('base64'),
      },
    });
    expect(engine.runDocuments.mock.calls[0]![2]).toBe('bytes');
    // A team app's bytes need no write scope and land nowhere.
    expect(scope.homes).toEqual([]);
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('bytes: past the cap of a mini app read, refused', async () => {
    engine.runDocuments.mockResolvedValue({
      kind: 'bytes',
      route: 'chromium/convert/html',
      bytes: Buffer.alloc(APP_BYTES_MAX + 1),
      contentType: 'application/pdf',
      filename: 'big.pdf',
    });
    expect(await by.pdf_render!.handler({ html: 'x', bytes: true }, appCtx('admin'))).toMatchObject(
      { ok: false, error: expect.stringMatching(/^big\.pdf is 16\.0 MB, past the 16\.0 MB/) },
    );
  });

  it('a team app prints no page or drawing of the brain', async () => {
    scope.writes = true;
    scope.ws = { ws: [HOLDER], modWs: [HOLDER] };
    for (const t of [by.pdf_render!, by.screenshot_render!]) {
      for (const bytes of [true, false]) {
        expect(await t.handler({ node_id: 'n1', bytes }, appCtx('team'))).toMatchObject({
          ok: false,
          error: expect.stringContaining("can't print a page or a drawing"),
        });
      }
    }
    expect(engine.runDocuments).not.toHaveBeenCalled();
  });

  it("a team app's file lands in the workspace that holds the app, for a moderator of it", async () => {
    scope.writes = true;
    scope.ws = { ws: [HOLDER], modWs: [HOLDER] };
    expect(await by.office_to_pdf!.handler({ file_ids: ['f'] }, appCtx('team'))).toMatchObject({
      ok: true,
      output: { file_id: 'f1' },
    });
    expect(scope.homes).toEqual([{ createWs: HOLDER, privateWs: HOLDER }]);
    // Found by its metadata, read by no model: a loop of saves spends nothing.
    expect(engine.runDocuments.mock.calls[0]![0]).toMatchObject({ indexing: 'metadata' });
  });

  it("a team app reads a PDF's metadata without a save, so without a moderator", async () => {
    engine.runDocuments.mockResolvedValue({
      kind: 'json',
      route: 'pdfengines/metadata/read',
      json: { 'a.pdf': {} },
    });
    scope.writes = false;
    scope.ws = { ws: [HOLDER], modWs: [] };
    expect(
      await by.pdf_tools!.handler({ op: 'metadata_read', file_ids: ['f'] }, appCtx('team')),
    ).toMatchObject({ ok: true, output: { result: { 'a.pdf': {} } } });
    expect(scope.homes).toEqual([]);
  });

  it('an app call with no rules named runs at team rules (fail closed)', async () => {
    const ctxNoRules: ToolHandlerContext = {
      ownerId: 'o1',
      caller: { entry: 'app', via: 'app' } as unknown as ToolCaller,
    };
    expect(await by.pdf_render!.handler({ node_id: 'n1' }, ctxNoRules)).toMatchObject({
      ok: false,
      error: expect.stringContaining("can't print a page"),
    });
    // An agent's call (no app rules) is no team app: it prints as before.
    expect(await by.pdf_render!.handler({ node_id: 'n1' }, ctx)).toMatchObject({ ok: true });
  });

  it("a team app's save is refused, saying to take the bytes, when it may not land", async () => {
    const cases: [boolean, null | { ws: string[]; modWs: string[] }, RegExp][] = [
      [
        false,
        { ws: [HOLDER], modWs: [HOLDER] },
        /can't save a file: a team app saves only in a request that may write/,
      ],
      [true, { ws: [], modWs: [] }, /no workspace to land in/],
      [true, null, /no workspace to land in/],
      [true, { ws: [HOLDER], modWs: [] }, /needs a user who moderates it/],
    ];
    for (const [writes, ws, why] of cases) {
      scope.writes = writes;
      scope.ws = ws;
      const out = await by.pdf_tools!.handler({ op: 'merge', file_ids: ['f'] }, appCtx('team'));
      expect(out).toMatchObject({ ok: false, error: expect.stringMatching(why) });
      expect((out as { error: string }).error).toContain('Pass bytes: true');
    }
    expect(engine.runDocuments).not.toHaveBeenCalled();
    expect(scope.homes).toEqual([]);
  });

  it("an admin-held app's call lands where an admin's export lands, as before", async () => {
    expect(await by.pdf_render!.handler({ node_id: 'n1' }, appCtx('admin'))).toMatchObject({
      ok: true,
      output: { file_id: 'f1' },
    });
    expect(scope.homes).toEqual([]);
    expect(engine.runDocuments.mock.calls[0]![2]).toBeUndefined();
    expect(engine.runDocuments.mock.calls[0]![0]).not.toHaveProperty('indexing');
  });
});

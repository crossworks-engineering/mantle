/**
 * The four documents tools: each names its route from its arguments
 * (pdf_render and screenshot_render pick url, html or markdown from what the
 * caller gave; pdf_tools maps `op` to the PDF-engine route), hands the
 * inputs and options through untouched, runs as the acting login (the
 * render cookie), and answers the landed file (or the JSON of a read). A
 * package error is the tool's error text. The policy: a write that makes a
 * file, spends nothing, not mcpOnly, and the config gate names the same
 * four slugs. A team app refuses them (the flagged seam).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ runDocuments: vi.fn() }));
vi.mock('@mantle/documents', () => ({ runDocuments: engine.runDocuments }));
const actor = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  currentActor: () => actor.current,
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { toolService } from '@mantle/config';
import { recordIngest } from '@mantle/tracing';
import { DOCUMENT_TOOLS, PDF_TOOL_OPS } from './builtins-documents';
import { memberAppRefusal, TEAM_APP_TOOLS_ALLOWED } from './runtime-policy';
import type { ToolHandlerContext } from './types';

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
});

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

  it('a team app refuses them: they write (the flagged seam of v1)', () => {
    for (const t of DOCUMENT_TOOLS) {
      expect(
        memberAppRefusal(
          t.slug,
          `builtin:${t.slug}`,
          { readOnly: false, spends: false },
          false,
          () => false,
        ),
      ).toContain(TEAM_APP_TOOLS_ALLOWED);
    }
  });
});

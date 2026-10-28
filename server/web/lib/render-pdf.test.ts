/**
 * renderNodeToPdf's engine branch: what reaches the documents engine for a
 * page or drawing print (the node, the header and footer documents only
 * when set, the paper in inches swapped for landscape, the margins in
 * inches, backgrounds, never a landscape or url field) and who it prints
 * as (the acting admin). The engine and the sidecar are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ available: true, runDocuments: vi.fn() }));
vi.mock('@mantle/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/documents')>()),
  documentsAvailable: () => engine.available,
  runDocuments: engine.runDocuments,
}));
vi.mock('puppeteer-core', () => ({ default: { connect: vi.fn() } }));

import { DEFAULT_PRINT_OPTIONS } from './print-options';
import { renderNodeToPdf } from './render-pdf';

const WHO = { ownerId: 'anchor-1', actorId: 'admin-1' };

beforeEach(() => {
  engine.available = true;
  engine.runDocuments.mockReset();
  engine.runDocuments.mockResolvedValue({
    kind: 'bytes',
    route: 'chromium/convert/url',
    bytes: Buffer.from('%PDF'),
    contentType: 'application/pdf',
    filename: 'page.pdf',
  });
});

describe('renderNodeToPdf through the documents engine', () => {
  it('prints the node as the acting admin with the default a4 portrait print', async () => {
    const bytes = await renderNodeToPdf('page', 'node-1', WHO);
    expect(bytes.toString()).toBe('%PDF');
    expect(engine.runDocuments).toHaveBeenCalledWith(
      {
        route: 'chromium/convert/url',
        inputs: { node_id: 'node-1' },
        options: {
          paperWidth: 8.27,
          paperHeight: 11.69,
          marginTop: 0.709,
          marginBottom: 0.709,
          marginLeft: 0.63,
          marginRight: 0.63,
          printBackground: true,
        },
      },
      { ownerId: 'anchor-1', actorLoginId: 'admin-1' },
      'bytes',
    );
  });

  it('landscape swaps the paper; a header and a footer go as full documents; no url or landscape field', async () => {
    await renderNodeToPdf('draw', 'node-2', WHO, {
      ...DEFAULT_PRINT_OPTIONS,
      paper: 'letter',
      landscape: true,
      margins: { top: 10, right: 10, bottom: 14, left: 10 },
      header: 'Q3 <pack>',
      footer: null,
      pageNumbers: true,
    });
    const call = engine.runDocuments.mock.calls[0]![0] as {
      inputs: Record<string, string>;
      options: Record<string, unknown>;
    };
    expect(call.options).toMatchObject({ paperWidth: 11, paperHeight: 8.5, marginBottom: 0.551 });
    expect(call.options).not.toHaveProperty('landscape');
    expect(call.options).not.toHaveProperty('url');
    expect(call.inputs.node_id).toBe('node-2');
    expect(call.inputs.header_html).toMatch(/^<!doctype html>.*Q3 &lt;pack&gt;/);
    expect(call.inputs.footer_html).toContain('class="pageNumber"');
  });

  it('answers unavailable when the engine hands back no bytes', async () => {
    engine.runDocuments.mockResolvedValue({ kind: 'json', route: 'x', json: {} });
    await expect(renderNodeToPdf('page', 'node-1', WHO)).rejects.toThrow(
      /PDF renderer unavailable/,
    );
  });
});

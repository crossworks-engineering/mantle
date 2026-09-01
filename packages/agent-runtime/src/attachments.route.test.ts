/**
 * Attachment ROUTING must follow the extension for routed formats, never the
 * client-supplied mime. The replayed defect: uploads label a DWG
 * `image/vnd.dwg` (a registered alias), the old mime-first gate sent the CAD
 * binary to the vision worker, and the live turn "read" an empty image
 * instead of taking the dwg background-index deferral.
 *
 * `@mantle/db` is mocked so a WRONG route (into the vision branch) fails
 * loudly on worker lookup rather than reaching for a real database.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', () => ({
  bumpWorkerUsage: vi.fn(),
  getDefaultWorker: vi.fn(async () => {
    throw new Error('vision branch must not run for a routed CAD extension');
  }),
}));
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: vi.fn(async () => null) }));

import { extractAttachmentForTurn } from './attachments';

describe('extractAttachmentForTurn — ext routing beats client mime', () => {
  it('defers a DWG labelled image/vnd.dwg to the background extractor', async () => {
    const out = await extractAttachmentForTurn({
      ownerId: 'o-1',
      bytes: Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.alloc(64)]),
      mimeType: 'image/vnd.dwg',
      filename: '90-10-01.dwg',
    });
    expect(out.kind).toBe('file');
    expect(out.text).toBe('');
    expect(out.note).toContain('indexed in the background');
  });

  it('defers a DXF labelled image/vnd.dxf to the background extractor', async () => {
    const out = await extractAttachmentForTurn({
      ownerId: 'o-1',
      bytes: Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'),
      mimeType: 'image/vnd.dxf',
      filename: '90-10-02.dxf',
    });
    expect(out.kind).toBe('file');
    expect(out.text).toBe('');
    expect(out.note).toContain('indexed in the background');
  });
});

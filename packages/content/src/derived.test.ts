import { describe, expect, it } from 'vitest';
import { isPerDocumentExtractedImagesPath } from './derived';

/**
 * The folder-deletion guard for the image reap. The invariant it protects:
 * deleteFolder may only ever target a per-document child of the shared
 * extracted-images tree — deleting the root (or an unrelated folder an image
 * somehow lives in) is the one folder-level mistake the reap could make.
 * (Emptiness is deleteFolder's own refusal; this guard is about WHICH paths
 * are ever attempted.)
 */
describe('isPerDocumentExtractedImagesPath', () => {
  it('accepts a per-document child of files.extracted_images', () => {
    expect(isPerDocumentExtractedImagesPath('files.extracted_images.owners_manual')).toBe(true);
  });

  it('rejects the shared extracted-images root itself', () => {
    expect(isPerDocumentExtractedImagesPath('files.extracted_images')).toBe(false);
  });

  it('rejects the files root and unrelated folders', () => {
    expect(isPerDocumentExtractedImagesPath('files')).toBe(false);
    expect(isPerDocumentExtractedImagesPath('files.work.acme')).toBe(false);
    expect(isPerDocumentExtractedImagesPath('inbox.email_alex')).toBe(false);
  });

  it('rejects a lookalike label that merely shares the prefix', () => {
    expect(isPerDocumentExtractedImagesPath('files.extracted_images_backup.doc')).toBe(false);
  });
});

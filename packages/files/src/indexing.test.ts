import { describe, it, expect } from 'vitest';
import { ownIndexingMode, metadataSpineText } from './indexing';

/**
 * The pure halves of the metadata-only switch. Resolution and the re-queue
 * sweep are DB-bound and exercised through the extractor's own flow; what is
 * testable without a database is the flag parser (which must fail CLOSED — an
 * unrecognised value means inherit, never metadata) and the spine text (which
 * is both the summary a person reads and the embedding input, so its shape is
 * a contract, not cosmetics).
 */
describe('ownIndexingMode', () => {
  it('reads the two valid values and nothing else', () => {
    expect(ownIndexingMode({ indexing: 'metadata' })).toBe('metadata');
    expect(ownIndexingMode({ indexing: 'full' })).toBe('full');
  });

  it('treats absent, null, and junk as inherit (null)', () => {
    // Junk failing toward 'metadata' would silently UN-index content; junk
    // failing toward 'full' would override an ancestor's opt-out. Both wrong —
    // an unrecognised value must mean "no opinion".
    expect(ownIndexingMode(null)).toBeNull();
    expect(ownIndexingMode({})).toBeNull();
    expect(ownIndexingMode({ indexing: true })).toBeNull();
    expect(ownIndexingMode({ indexing: 'METADATA' })).toBeNull();
    expect(ownIndexingMode({ indexing: 'none' })).toBeNull();
  });
});

describe('metadataSpineText', () => {
  const node = {
    title: 'holiday-2026.jpg',
    path: 'files.photos.iceland',
    tags: ['file', 'holiday', 'iceland'],
    data: {
      filename: 'holiday-2026.jpg',
      extension: 'jpg',
      mime_type: 'image/jpeg',
    },
  };

  it('names the file, its type, its folder and its tags — never content', () => {
    const spine = metadataSpineText(node);
    expect(spine).toContain('holiday-2026.jpg');
    expect(spine).toContain('JPG file');
    expect(spine).toContain('image/jpeg');
    expect(spine).toContain('files.photos.iceland');
    expect(spine).toContain('holiday, iceland');
    // The machinery tag is noise to a reader and to the embedding alike.
    expect(spine).toContain('Tags: holiday, iceland.');
  });

  it('says out loud that content is not searchable', () => {
    // The spine is what search returns for this node. Without this line, an
    // agent quoting the summary would present a name-only index as if it had
    // read the file.
    expect(metadataSpineText(node)).toContain('content is not searchable');
  });

  it('survives a node with bare data', () => {
    const spine = metadataSpineText({ title: 'x.bin', path: 'files', tags: [], data: {} });
    expect(spine).toContain('x.bin');
    expect(spine).toContain('files');
  });
});

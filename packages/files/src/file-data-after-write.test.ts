import { describe, expect, it } from 'vitest';
import { BYTE_DERIVED_DATA_KEYS, fileDataAfterWrite } from './ops/files';

/** A file node's data after one extract: storage, settings, and index. */
const OLD = {
  filename: 'plan.pdf',
  sha256: 'old',
  size_bytes: 10,
  indexing: 'metadata',
  sourceFileId: 'parent-1',
  summary: 'The old plan.',
  summary_model: 'm',
  summary_at: '2026-10-01',
  entities: ['Old Co'],
  text: 'old extracted text',
  schemaDigest: 'cols',
  extract_completed_at: '2026-10-01',
  extract_incomplete: { reason: 'fact_cost_cap' },
  indexing_applied: 'metadata',
};
const NEW = { filename: 'plan.pdf', sha256: 'new', size_bytes: 12 };

describe('fileDataAfterWrite', () => {
  it('keeps settings and provenance on new bytes, and drops all the old index', () => {
    const next = fileDataAfterWrite(OLD, NEW, true);
    expect(next).toMatchObject({
      sha256: 'new',
      size_bytes: 12,
      indexing: 'metadata',
      sourceFileId: 'parent-1',
    });
    for (const key of BYTE_DERIVED_DATA_KEYS) expect(next).not.toHaveProperty(key);
  });

  it('keeps the index when the bytes are the same', () => {
    const next = fileDataAfterWrite(OLD, { ...NEW, sha256: 'old' }, false);
    expect(next).toMatchObject({ summary: 'The old plan.', extract_completed_at: '2026-10-01' });
  });

  it('drops a cached body from the old bytes unless new content came with them', () => {
    const old = { ...OLD, content: 'old body' };
    expect(fileDataAfterWrite(old, NEW, true)).not.toHaveProperty('content');
    expect(fileDataAfterWrite(old, { ...NEW, content: 'new body' }, true).content).toBe('new body');
  });
});

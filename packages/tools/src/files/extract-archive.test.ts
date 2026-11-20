/**
 * archiveExtractViewOf (docs/files.md, "Archives"): a queued or running
 * stamp past ARCHIVE_EXTRACT_STALE_MS (the agent stopped in the middle)
 * reads as failed with a sentence, so the client stops polling and a person
 * may ask again; a fresh one reads as it is stored, and so does a done one.
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveExtractStamp } from '@mantle/files';
import { archiveExtractViewOf } from './extract-archive';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

const stamp = (over: Partial<ArchiveExtractStamp>): ArchiveExtractStamp => ({
  state: 'running',
  folder_id: 'ff000000-0000-4000-8000-000000000001',
  folder_path: 'Files/drop (contents)',
  at: ago(60_000),
  files: 3,
  folders: 1,
  bytes: 1024,
  skipped: 0,
  flattened: 0,
  refused: [],
  refused_count: 0,
  ...over,
});

describe('archiveExtractViewOf', () => {
  it('a running stamp 4 hours old reads failed, with the sentence', () => {
    const v = archiveExtractViewOf(stamp({ at: ago(4 * HOUR), started_at: ago(4 * HOUR) }));
    expect(v.state).toBe('failed');
    expect(v.error).toBe('The extraction stopped before it finished. Ask again to extract it.');
    expect(v.files).toBe(3);
  });

  it('a queued stamp 4 hours old reads failed too', () => {
    const v = archiveExtractViewOf(stamp({ state: 'queued', at: ago(4 * HOUR) }));
    expect(v.state).toBe('failed');
    expect(v.error).toMatch(/Ask again/);
  });

  it('a running stamp 1 minute old reads running, with no error', () => {
    const v = archiveExtractViewOf(stamp({ at: ago(60_000) }));
    expect(v.state).toBe('running');
    expect(v.error).toBeUndefined();
  });

  it('a done stamp is unchanged, however old', () => {
    const at = ago(4 * HOUR);
    const v = archiveExtractViewOf(stamp({ state: 'done', at, finished_at: at }));
    expect(v.state).toBe('done');
    expect(v.error).toBeUndefined();
    expect(v.finishedAt).toBe(at);
  });

  it('a failed stamp keeps its own error', () => {
    const v = archiveExtractViewOf(
      stamp({ state: 'failed', at: ago(4 * HOUR), error: 'Too big.' }),
    );
    expect(v.state).toBe('failed');
    expect(v.error).toBe('Too big.');
  });
});

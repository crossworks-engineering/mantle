/**
 * The forum-archive boot task (member logins, Phase 6) runs the export only
 * while unexported topics exist, and never throws into boot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: 'o1' as string | null,
  unexported: 0,
  exportCalls: 0,
  exportError: null as Error | null,
}));

vi.mock('@mantle/db', () => ({ resolveSingleOwnerId: vi.fn(async () => h.owner) }));
vi.mock('@mantle/content', () => ({
  countUnexportedForumTopics: vi.fn(async () => h.unexported),
  exportForumArchive: vi.fn(async () => {
    h.exportCalls++;
    if (h.exportError) throw h.exportError;
    return {
      status: 'done',
      exported: h.unexported,
      deferred: 0,
      alreadyExported: 0,
      archivePageId: 'p1',
      dumpFileId: 'f1',
      uploadsFiled: 0,
      uploadsMissing: 0,
      tasksLinked: 0,
    };
  }),
}));

import { runForumArchiveBootTask } from './forum-archive-boot';

beforeEach(() => {
  h.owner = 'o1';
  h.unexported = 0;
  h.exportCalls = 0;
  h.exportError = null;
});

describe('forum archive boot task', () => {
  it('does nothing once every topic is exported', async () => {
    await runForumArchiveBootTask(() => {});
    expect(h.exportCalls).toBe(0);
  });

  it('does nothing with no owner yet', async () => {
    h.owner = null;
    h.unexported = 3;
    await runForumArchiveBootTask(() => {});
    expect(h.exportCalls).toBe(0);
  });

  it('exports while unexported topics exist', async () => {
    h.unexported = 3;
    const lines: string[] = [];
    await runForumArchiveBootTask((l) => lines.push(l));
    expect(h.exportCalls).toBe(1);
    expect(lines[0]).toMatch(/3 topic\(s\) exported/);
  });

  it('never throws into boot', async () => {
    h.unexported = 1;
    h.exportError = new Error('db down');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runForumArchiveBootTask(() => {})).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

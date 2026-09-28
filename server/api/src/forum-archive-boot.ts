/**
 * One-time boot task: export the retired team forum into the Forum archive
 * (member logins, Phase 6; packages/content/src/forum/export.ts).
 *
 * Runs at every api start, but does work only while a topic has no archive
 * page yet: one count query, then nothing, once the archive is complete. The
 * export is idempotent and holds an advisory lock, so a boot that races the
 * admin's Export button gets `busy` and leaves the run to the button. It
 * never blocks boot and never throws: a failure is logged and the next boot
 * (or the button) tries again. No LLM or embedding work (see export.ts).
 */
import { resolveSingleOwnerId } from '@mantle/db';
import { countUnexportedForumTopics, exportForumArchive } from '@mantle/content';
import { errorMessage } from '@mantle/std';

export async function runForumArchiveBootTask(
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  try {
    const owner = await resolveSingleOwnerId();
    if (!owner) return;
    const unexported = await countUnexportedForumTopics(owner);
    if (unexported === 0) return;
    const res = await exportForumArchive(owner);
    if (res.status === 'busy') {
      log('[api] forum archive: another export is running; leaving it to that run');
      return;
    }
    log(
      `[api] forum archive: ${res.exported} topic(s) exported, ${res.deferred} deferred, ` +
        `${res.uploadsFiled} upload(s) filed, ${res.uploadsMissing} missing, ` +
        `${res.tasksLinked} task(s) linked`,
    );
  } catch (err) {
    console.error('[api] forum archive boot export failed:', errorMessage(err));
  }
}

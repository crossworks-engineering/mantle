/**
 * The Sync sidecar's one lane (Sync service plan M2): every job runs one at a
 * time, so memory stays flat (one mailbox or one feed in hand). A timer
 * looks once a minute for a mailbox due (every 5 minutes) or a feed due
 * (every 30 minutes); a backfill, a "Sync now" and a save join the same lane.
 * M3: a Microsoft drive (every 5 minutes) and an Outlook inbox (every 5).
 */
import { errorMessage } from '@mantle/std';
import type { Brain } from './brain';
import { runFeed } from './feeds';
import { runDrive } from './files';
import { outlookAccounts, runMailbox, runOutlookMail } from './mail';
import type { State } from './state';

export const MAIL_EVERY_MS = 5 * 60_000;
export const FEED_EVERY_MS = 30 * 60_000;
export const DRIVE_EVERY_MS = 5 * 60_000;
const TICK_MS = 60_000;

export type Lane = {
  /** Run `job` after every job before it. Its errors are logged only. */
  run(name: string, job: () => Promise<unknown>): Promise<void>;
  /** Run `job` after every job before it, and answer its result or throw
   *  its error (a removal: it waits for a run of the same account). */
  exclusive<T>(job: () => Promise<T>): Promise<T>;
  /** Jobs waiting or running. */
  depth(): number;
};

export function createLane(): Lane {
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;
  return {
    run(name, job) {
      depth += 1;
      const next = tail.then(async () => {
        try {
          await job();
        } catch (err) {
          console.warn(`[sync] ${name} failed: ${errorMessage(err)}`);
        } finally {
          depth -= 1;
        }
      });
      tail = next;
      return next;
    },
    exclusive<T>(job: () => Promise<T>): Promise<T> {
      depth += 1;
      const result = tail.then(job).finally(() => {
        depth -= 1;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    depth: () => depth,
  };
}

export type Scheduler = { stop(): void; tick(): Promise<void>; runNow(id: string): void };

export function createScheduler(brain: Brain, state: State, lane: Lane): Scheduler {
  const lastRun = new Map<string, number>();
  const due = (id: string, every: number, now: number) => now - (lastRun.get(id) ?? 0) >= every;

  async function tick(): Promise<void> {
    // A tick that finds the lane busy waits for the next: no pile-up.
    if (lane.depth() > 0) return;
    const now = Date.now();
    let accounts;
    let feeds;
    let drives;
    let outlook;
    try {
      [accounts, feeds, drives, outlook] = await Promise.all([
        state.accounts(),
        state.feeds(),
        state.msDrives(),
        outlookAccounts(state),
      ]);
    } catch (err) {
      console.warn(`[sync] could not read the accounts from the brain: ${errorMessage(err)}`);
      return;
    }
    for (const a of accounts) {
      if (!a.enabled || !due(a.id, MAIL_EVERY_MS, now)) continue;
      lastRun.set(a.id, now);
      void lane.run('mailbox run', () => runMailbox(brain, state, a));
    }
    for (const f of feeds) {
      if (!f.enabled || !due(f.id, FEED_EVERY_MS, now)) continue;
      lastRun.set(f.id, now);
      void lane.run('feed run', () => runFeed(brain, state, f));
    }
    for (const a of outlook) {
      if (!due(a.mailboxId, MAIL_EVERY_MS, now)) continue;
      lastRun.set(a.mailboxId, now);
      void lane.run('Outlook run', () => runOutlookMail(brain, state, a));
    }
    for (const d of drives) {
      if (!d.enabled || !due(d.id, DRIVE_EVERY_MS, now)) continue;
      lastRun.set(d.id, now);
      // Read again in the lane: a drive switched off or removed meanwhile
      // does not run.
      void lane.run('drive run', async () => {
        const fresh = await state.msDrive(d.id);
        if (fresh?.enabled) await runDrive(brain, state, fresh);
      });
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  return {
    stop: () => clearInterval(timer),
    tick,
    // The next tick runs it (a save, "Sync now").
    runNow: (id) => {
      lastRun.delete(id);
      void tick();
    },
  };
}

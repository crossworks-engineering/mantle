/**
 * The parser's job slots: at most `maxJobs` jobs run at once, at most
 * `queueMax` requests wait for one, each at most `waitMs`, then `busy`.
 *
 * An interactive request (a person is waiting: a chat attachment, a
 * thumbnail) goes to the HEAD of the queue, behind the interactive ones
 * already there, and waits at most `interactiveWaitMs`, then `busy`. There
 * is no second slot: it takes the next one that frees. Interactive and
 * background waiters are capped at `queueMax` each, so a full background
 * queue never turns a person away at once.
 *
 * A request takes its slot BEFORE its body is read (./main.ts): a request
 * that cannot run soon is refused without a byte of its file on disk, and
 * the scratch space holds the files of the running jobs only.
 */
import { JobFailure } from './job-failure';

type Waiter = { resolve: () => void; timer: NodeJS.Timeout; interactive: boolean };

export class Slots {
  private running_ = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly maxJobs: number,
    readonly queueMax: number,
    readonly waitMs: number,
    readonly interactiveWaitMs: number = waitMs,
  ) {}

  get running(): number {
    return this.running_;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** A slot, or a `busy` refusal: the queue is full, or the wait passed. */
  acquire(opts: { interactive?: boolean } = {}): Promise<void> {
    const interactive = opts.interactive === true;
    if (this.running_ < this.maxJobs) {
      this.running_++;
      return Promise.resolve();
    }
    const same = this.queue.filter((w) => w.interactive === interactive).length;
    if (same >= this.queueMax) {
      return Promise.reject(
        new JobFailure('busy', `every job slot is taken and ${this.queueMax} wait already`),
      );
    }
    const waitMs = interactive ? this.interactiveWaitMs : this.waitMs;
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        interactive,
        resolve: () => {
          clearTimeout(entry.timer);
          this.running_++;
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new JobFailure('busy', `no job slot came free within ${waitMs / 1000} s`));
        }, waitMs),
      };
      if (interactive) {
        // Behind the interactive waiters, ahead of every background one.
        const at = this.queue.findIndex((w) => !w.interactive);
        this.queue.splice(at < 0 ? this.queue.length : at, 0, entry);
      } else {
        this.queue.push(entry);
      }
    });
  }

  /** A slot is free again: the head of the queue takes it. */
  release(): void {
    this.running_ = Math.max(0, this.running_ - 1);
    this.queue.shift()?.resolve();
  }
}

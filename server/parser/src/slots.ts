/**
 * The parser's one job slot: one job at a time (it has the container's
 * whole memory and scratch space), at most `queueMax` requests wait for the
 * slot, each at most `waitMs`, then `busy`.
 *
 * An interactive request (a person is waiting: a chat attachment, a
 * thumbnail) goes to the HEAD of the queue, behind the interactive ones
 * already there, and waits at most `interactiveWaitMs`, then `busy`. There
 * is no second slot: it takes the slot when it frees. Interactive and
 * background waiters are capped at `queueMax` each, so a full background
 * queue never turns a person away at once.
 *
 * A request takes the slot BEFORE its body is read (./main.ts): a request
 * that cannot run soon is refused without a byte of its file on disk.
 *
 * `close` ends the queue for good: the parser is about to restart
 * (./main.ts), so every waiter and every later request is answered
 * `unavailable`, which the client retries and never counts against a file.
 */
import { JobFailure } from './job-failure';

type Waiter = {
  resolve: () => void;
  reject: (err: JobFailure) => void;
  timer: NodeJS.Timeout;
  interactive: boolean;
};

export class Slots {
  private heldSince_: number | null = null;
  private closed: string | null = null;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly queueMax: number,
    readonly waitMs: number,
    readonly interactiveWaitMs: number = waitMs,
  ) {}

  /** 1 while a job holds the slot, else 0. */
  get running(): number {
    return this.heldSince_ === null ? 0 : 1;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** How long the slot has been held, in ms (0 when free). */
  heldMs(now = Date.now()): number {
    return this.heldSince_ === null ? 0 : now - this.heldSince_;
  }

  /** The slot, or a refusal: `busy` (the queue is full, or the wait
   *  passed), `unavailable` (the parser is restarting). */
  acquire(opts: { interactive?: boolean } = {}): Promise<void> {
    if (this.closed !== null) return Promise.reject(new JobFailure('unavailable', this.closed));
    const interactive = opts.interactive === true;
    if (this.heldSince_ === null) {
      this.heldSince_ = Date.now();
      return Promise.resolve();
    }
    const same = this.queue.filter((w) => w.interactive === interactive).length;
    if (same >= this.queueMax) {
      return Promise.reject(
        new JobFailure('busy', `the job slot is taken and ${this.queueMax} wait already`),
      );
    }
    const waitMs = interactive ? this.interactiveWaitMs : this.waitMs;
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        interactive,
        resolve: () => {
          clearTimeout(entry.timer);
          this.heldSince_ = Date.now();
          resolve();
        },
        reject: (err) => {
          clearTimeout(entry.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(
            new JobFailure('busy', `the job slot did not come free within ${waitMs / 1000} s`),
          );
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

  /** The slot is free again: the head of the queue takes it. */
  release(): void {
    this.heldSince_ = null;
    if (this.closed === null) this.queue.shift()?.resolve();
  }

  /** No job runs again in this process: every waiter, and every later
   *  request, is refused `unavailable` with `why`. */
  close(why: string): void {
    this.closed = why;
    for (const w of this.queue.splice(0)) w.reject(new JobFailure('unavailable', why));
  }
}

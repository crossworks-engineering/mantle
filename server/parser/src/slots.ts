/**
 * The parser's job slots: at most `maxJobs` jobs run at once, at most
 * `queueMax` requests wait for one, each at most `waitMs`, then `busy`.
 *
 * A request takes its slot BEFORE its body is read (./main.ts): a request
 * that cannot run soon is refused without a byte of its file on disk, and
 * the scratch space holds the files of the running jobs only.
 */
import { JobFailure } from './job-failure';

export class Slots {
  private running_ = 0;
  private readonly queue: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    readonly maxJobs: number,
    readonly queueMax: number,
    readonly waitMs: number,
  ) {}

  get running(): number {
    return this.running_;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** A slot, or a `busy` refusal: the queue is full, or the wait passed. */
  acquire(): Promise<void> {
    if (this.running_ < this.maxJobs) {
      this.running_++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueMax) {
      return Promise.reject(
        new JobFailure('busy', `every job slot is taken and ${this.queueMax} wait already`),
      );
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.running_++;
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new JobFailure('busy', `no job slot came free within ${this.waitMs / 1000} s`));
        }, this.waitMs),
      };
      this.queue.push(entry);
    });
  }

  /** A slot is free again: the longest waiter takes it. */
  release(): void {
    this.running_ = Math.max(0, this.running_ - 1);
    this.queue.shift()?.resolve();
  }
}

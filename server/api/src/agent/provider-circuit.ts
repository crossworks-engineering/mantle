/**
 * The extract queue's provider circuit (2026-10-04, docs/embeddings.md
 * "Provider outages").
 *
 * What went wrong: an embedding account ran out of credits. Every extract job
 * failed, retried five times with backoff, and went to the dead-letter queue,
 * for days. When an admin fixed the provider, nothing moved: the dead letters
 * are re-driven only at agent start and the unextracted nodes only swept at
 * boot, so it took a restart.
 *
 * What this does:
 *
 *  1. OPEN on a confirmed account error. A job fails with a PERMANENT class
 *     (no credits, refused key, unknown model, no key: provider-error.ts).
 *     One tiny probe call confirms it is the account and not this one
 *     document; then the queue pauses (no worker takes a job, so nothing
 *     burns its retries), and the alert row is marked paused and shown to
 *     admins. Transient errors (rate limit, 5xx, network) never pause: the
 *     queue's own retry and backoff are the right tool for them.
 *
 *  2. PROBE while failing. Each open, shown alert gets ONE tiny call at
 *     5 min, then 10, 20, 40, then every 60 min (`probeDelayMs`). Never a
 *     storm: one probe in flight at a time, and only while an alert is open.
 *     An admin's "Try again", a config save and a restart probe at once.
 *
 *  3. RECOVER when it works again: close the alert, resume the workers,
 *     re-drive the dead-letter queue and run the unextracted-node sweep (the
 *     same bounded code paths as at boot: 1000 jobs, 1000 nodes). Recovery
 *     also runs when an alert closes elsewhere (any embed that works closes
 *     it), and on a config change or an admin request while jobs wait.
 *
 * Cost bounds (cost-safety rule): a probe is one request of a few tokens, at
 * most 26 a day per subject while an outage lasts (4 in the first 75 min,
 * then one an hour), and none while all
 * is well. A recovery enqueues at most 1000 + 1000 jobs, which run through
 * the queue's own worker count and retry policy, and it runs at most once per
 * 30 min on its own (probe success, an alert closing) and at most once per
 * 2 min on an admin action (config save, "Try again"). A job that fails for
 * its own reason gets one more round of 6 attempts per recovery, as it does
 * per restart today.
 *
 * Pure logic over injected dependencies (`CircuitDeps`), so the tests drive
 * every transition with fakes: no database, no queue, no clock.
 */
import {
  classifyProviderError,
  providerSubjectOf,
  type ProviderErrorClass,
  type ProviderSubject,
} from '@mantle/embeddings';

export const FIRST_PROBE_MS = 5 * 60_000;
export const MAX_PROBE_MS = 60 * 60_000;
/** Between two confirm probes (a stream of failing jobs asks for many). */
export const CONFIRM_GAP_MS = 60_000;
/** Between two automatic recoveries (a probe that works, an alert closing). */
export const AUTO_RECOVERY_GAP_MS = 30 * 60_000;
/** Between two recoveries an admin asked for (config save, "Try again"). */
export const ADMIN_RECOVERY_GAP_MS = 2 * 60_000;

/** Delay before the next probe after `failedProbes` failed ones:
 *  5, 10, 20, 40, 60, 60, ... minutes. */
export function probeDelayMs(failedProbes: number): number {
  return Math.min(FIRST_PROBE_MS * 2 ** Math.max(0, failedProbes), MAX_PROBE_MS);
}

export interface OpenAlert {
  subject: ProviderSubject;
  paused: boolean;
  visible: boolean;
  nextProbeAt: Date | null;
  probeAttempts: number;
}

export interface CircuitDeps {
  now(): number;
  /** One tiny call through the configured routes. Throws on failure. */
  probe(subject: ProviderSubject): Promise<void>;
  /** Stop taking extract jobs / take them again. */
  pauseWorkers(): Promise<void>;
  resumeWorkers(): Promise<void>;
  /** Re-drive the dead-letter queue and sweep unextracted nodes. */
  recover(): Promise<{ redriven: number }>;
  /** Jobs in the dead-letter queue (decides whether a config change has
   *  anything to recover). */
  deadLetterCount(): Promise<number>;
  store: {
    listOpen(): Promise<OpenAlert[]>;
    /** Open (or keep open) the alert with this class; used when the probe
     *  that confirmed it is the only failure this process has written. */
    recordFailure(subject: ProviderSubject, cls: ProviderErrorClass): Promise<void>;
    setPaused(subject: ProviderSubject, paused: boolean, nextProbeAt: Date | null): Promise<void>;
    probeFailed(subject: ProviderSubject, nextProbeAt: Date): Promise<void>;
    resolve(subject: ProviderSubject): Promise<boolean>;
  };
  log(msg: string): void;
}

export type RecoveryTrigger = 'probe' | 'resolved' | 'config' | 'admin';

export class ProviderCircuit {
  /** Subjects that hold the queue paused. */
  private readonly paused = new Set<ProviderSubject>();
  /** Open subjects at the last tick, to see one close elsewhere. */
  private knownOpen = new Set<ProviderSubject>();
  private probing = false;
  private lastConfirmAt = -Infinity;
  private lastRecoveryAt = -Infinity;
  /** Probe every open alert on the next tick (config change, admin, boot). */
  private probeNowRequested = false;
  /** A recovery an admin asked for, to run on the next tick. */
  private pendingRecovery: RecoveryTrigger | null = null;

  constructor(private readonly deps: CircuitDeps) {}

  isPaused(): boolean {
    return this.paused.size > 0;
  }

  /**
   * A job failed. Opens the circuit for a confirmed account error; ignores
   * everything else (the queue retries it as before).
   */
  async onJobError(err: unknown): Promise<void> {
    const cls = classifyProviderError(err);
    if (!cls?.permanent) return;
    const subject = providerSubjectOf(err) ?? 'extraction';
    if (this.paused.has(subject)) return;
    if (this.probing) return;
    const now = this.deps.now();
    if (now - this.lastConfirmAt < CONFIRM_GAP_MS) return;
    this.lastConfirmAt = now;
    this.probing = true;
    try {
      await this.deps.probe(subject);
      this.deps.log(
        `${subject}: a job failed with "${cls.code}" but the probe works: not the account, no pause`,
      );
    } catch (probeErr) {
      const confirmed = classifyProviderError(probeErr);
      if (confirmed?.permanent) await this.open(subject, confirmed);
    } finally {
      this.probing = false;
    }
  }

  private async open(subject: ProviderSubject, cls: ProviderErrorClass): Promise<void> {
    const first = this.paused.size === 0;
    this.paused.add(subject);
    this.knownOpen.add(subject);
    if (first) await this.deps.pauseWorkers();
    await this.deps.store.recordFailure(subject, cls);
    await this.deps.store.setPaused(subject, true, new Date(this.deps.now() + probeDelayMs(0)));
    this.deps.log(
      `${subject}: ${cls.reason} (${cls.code}). Extract queue paused; ` +
        `probe in ${probeDelayMs(0) / 60_000} min.`,
    );
  }

  /** A config save or an admin "Try again": probe open alerts now, and
   *  recover a waiting backlog even when no alert is open. */
  requestRecovery(trigger: 'config' | 'admin'): void {
    this.probeNowRequested = true;
    this.pendingRecovery = trigger;
  }

  /** Called every 30 s by the queue's reconcile loop, and once at start. */
  async tick(): Promise<void> {
    if (this.probing) return;
    const now = this.deps.now();
    const open = await this.deps.store.listOpen();
    const openSubjects = new Set(open.map((a) => a.subject));

    // An alert that closed elsewhere (an embed that worked, in any process):
    // resume, and recover once.
    let closedElsewhere = false;
    for (const s of this.knownOpen) {
      if (openSubjects.has(s)) continue;
      closedElsewhere = true;
      this.paused.delete(s);
    }
    this.knownOpen = openSubjects;
    if (closedElsewhere && !this.isPaused()) {
      await this.deps.resumeWorkers();
      await this.runRecovery('resolved');
    }

    let probedOk = false;
    const probeNow = this.probeNowRequested;
    this.probeNowRequested = false;
    const pending = this.pendingRecovery;
    this.pendingRecovery = null;
    for (const a of open) {
      // A paused row this process does not hold (it restarted): hold it
      // again, and probe now (a restart is a "try again" too).
      if (a.paused && !this.paused.has(a.subject)) {
        if (this.paused.size === 0) await this.deps.pauseWorkers();
        this.paused.add(a.subject);
        a.nextProbeAt = new Date(now);
      }
      if (!a.paused && !a.visible) continue; // a short blip: retries handle it
      if (!a.nextProbeAt) {
        await this.deps.store.setPaused(a.subject, a.paused, new Date(now + probeDelayMs(0)));
        if (!probeNow) continue;
      }
      const due = probeNow || (a.nextProbeAt !== null && a.nextProbeAt.getTime() <= now);
      if (!due) continue;
      this.probing = true;
      try {
        await this.deps.probe(a.subject);
        await this.deps.store.resolve(a.subject);
        this.paused.delete(a.subject);
        this.knownOpen.delete(a.subject);
        probedOk = true;
        this.deps.log(`${a.subject}: probe works: alert closed`);
      } catch {
        const next = new Date(now + probeDelayMs(a.probeAttempts + 1));
        await this.deps.store.probeFailed(a.subject, next);
        this.deps.log(
          `${a.subject}: probe failed (${a.probeAttempts + 1}); next in ` +
            `${Math.round((next.getTime() - now) / 60_000)} min`,
        );
      } finally {
        this.probing = false;
      }
    }

    if (probedOk && !this.isPaused()) {
      await this.deps.resumeWorkers();
      await this.runRecovery(pending ?? 'probe');
    }

    // An admin action with no open alert left: recover a waiting backlog,
    // after one probe proves the provider works (so up to 1000 jobs do not
    // run into the same wall).
    if (pending && !this.isPaused() && this.knownOpen.size === 0 && !probedOk) {
      if ((await this.deps.deadLetterCount()) > 0) {
        try {
          await this.deps.probe('embedding');
          await this.runRecovery(pending);
        } catch (err) {
          this.deps.log(`recovery on ${pending} skipped: the probe failed (${errorText(err)})`);
        }
      }
    }
  }

  private async runRecovery(trigger: RecoveryTrigger): Promise<void> {
    const now = this.deps.now();
    const gap =
      trigger === 'config' || trigger === 'admin' ? ADMIN_RECOVERY_GAP_MS : AUTO_RECOVERY_GAP_MS;
    if (now - this.lastRecoveryAt < gap) {
      this.deps.log(
        `recovery on ${trigger} skipped: the last one ran under ${gap / 60_000} min ago`,
      );
      return;
    }
    this.lastRecoveryAt = now;
    const { redriven } = await this.deps.recover();
    this.deps.log(
      `recovered on ${trigger}: re-drove ${redriven} dead-lettered job(s) and swept unextracted nodes`,
    );
  }
}

function errorText(err: unknown): string {
  const cls = classifyProviderError(err);
  return cls ? cls.code : 'error';
}

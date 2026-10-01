/**
 * When a running mini app is ready to be SEEN, as opposed to merely mounted.
 *
 * `ready` from the frame means React committed and painted once. Most apps
 * then load their data through the bridge (db.query / tool.call), which the
 * host page brokers, so the host can see those requests in flight. The gate
 * reveals the app once it has mounted AND:
 *
 *  - the app is not holding (`host.ui.holdReady()`), and
 *  - no bridge request has been in flight for `quietMs` (chained awaits hand
 *    over within a microtask, so a short window covers them),
 *
 * or at once when a holding app calls `host.ui.ready()`, and in any case
 * `maxMs` after mount, so a request that never settles can't pin the loader.
 *
 * Pure (timers injected via the global setTimeout, testable with fake timers);
 * one gate per frame load. Calls `onReveal` at most once.
 */

export const REVEAL_QUIET_MS = 150;
export const REVEAL_MAX_MS = 8_000;

export class RevealGate {
  private inflight = 0;
  private held = false;
  private released = false;
  private mounted = false;
  private done = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private cap: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onReveal: () => void,
    private readonly opts: { quietMs: number; maxMs: number } = {
      quietMs: REVEAL_QUIET_MS,
      maxMs: REVEAL_MAX_MS,
    },
  ) {}

  /** The frame posted `ready` (mounted and painted). */
  mount(): void {
    if (this.done || this.mounted) return;
    this.mounted = true;
    this.cap = setTimeout(() => this.reveal(), this.opts.maxMs);
    if (this.released) this.reveal();
    else this.check();
  }

  /** A bridge request left for the host. */
  requestStart(): void {
    this.inflight++;
    this.clearQuiet();
  }

  /** A bridge request was answered (either way). */
  requestEnd(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.check();
  }

  /** The app asked the host to keep the loader up. */
  hold(): void {
    if (this.released) return;
    this.held = true;
    this.clearQuiet();
  }

  /** The app declared itself ready: reveal now (or at mount, if earlier). */
  release(): void {
    this.held = false;
    this.released = true;
    if (this.mounted) this.reveal();
  }

  get revealed(): boolean {
    return this.done;
  }

  dispose(): void {
    this.done = true;
    this.clearQuiet();
    if (this.cap) clearTimeout(this.cap);
    this.cap = null;
  }

  private check(): void {
    if (this.done || !this.mounted || this.held || this.inflight > 0) return;
    this.clearQuiet();
    this.quiet = setTimeout(() => this.reveal(), this.opts.quietMs);
  }

  private clearQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  private reveal(): void {
    if (this.done) return;
    this.dispose();
    this.onReveal();
  }
}

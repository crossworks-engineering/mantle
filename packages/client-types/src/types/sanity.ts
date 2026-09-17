/**
 * System sanity checker — shared types.
 *
 * Distinct from the dashboard health pills (lib/system-health.ts), which answer
 * "is the service UP?". This surface answers "is the service CONFIGURED RIGHT?":
 * the class of break that hides in env vars or in a provisioning step only
 * `scripts/up.sh` performs, so a registry-pull box that never ran it looks
 * healthy yet a feature is silently dead. The motivating cases:
 *   • MinIO is up, but the `mantle` bucket was never created → every app build
 *     and upload fails with "The specified bucket does not exist".
 *   • The updater sidecar runs, but `MANTLE_STACK_DIR` is unset → it parks in
 *     phase `unconfigured` and every update silently hangs.
 *
 * Read-only by design: checks probe and report a remediation, they never mutate
 * infra (no bucket creation, no updater poke) from a web request.
 */

export type SanityStatus =
  /** Configured correctly. */
  | 'pass'
  /** Works, but a setting will bite later (cwd-relative files root, localhost
   *  public URL) — degraded, often expected on a dev box. */
  | 'warn'
  /** A feature is broken right now (missing bucket, unconfigured updater). */
  | 'fail'
  /** Subsystem isn't present on this deployment, so the check doesn't apply
   *  (no updater sidecar in dev, a remote embedder we can't probe). */
  | 'na';

export type SanityCategory = 'Storage' | 'Updater' | 'Environment' | 'Embedding' | 'Database';

/** How to fix a non-passing check. `command` is a copy-pasteable one-liner when
 *  one exists (e.g. the `mc mb` to create the bucket). */
export type SanityFix = { summary: string; command?: string };

export type SanityCheck = {
  key: string;
  label: string;
  category: SanityCategory;
  status: SanityStatus;
  /** What we found — actual vs expected, in one line. */
  detail: string;
  /** Remediation when not `pass`/`na`; null otherwise. */
  fix: SanityFix | null;
};

export type SanityReport = {
  generatedAt: string;
  checks: SanityCheck[];
  /** Counts for the headline summary. */
  fails: number;
  warns: number;
};

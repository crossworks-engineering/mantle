/**
 * Pool-fit report — the pure half.
 *
 * WHY THIS EXISTS: on 2026-09-02 the shipped curated template put Nano Banana
 * Pro (`google/gemini-3-pro-image`) in the vision ("Read images") pool. It is
 * an image GENERATOR. Generators accept image input exactly like readers do,
 * so nothing on the input side caught it, and every surface that offered the
 * pool offered it too. Four write paths now refuse that class of entry
 * (docs/model-pools.md), but a guard only protects the NEXT write — rows
 * already in `curated_models` and models already saved on a worker predate it,
 * and the seeder deliberately never rewrites an owner's curation.
 *
 * So: report, never rewrite. Removing a curated entry is the owner's call at
 * /models/pools, and repointing a worker is a cost decision — the same line
 * `pinned-model-drift` holds.
 *
 * Split from `pool-fit-run.ts` so the judgement is pure and testable with no
 * database and no network. The rule itself is `poolModelIssue` in
 * @mantle/client-types — one definition, shared with the four write guards.
 */
import { poolModelIssue, type ModelModalities } from '@mantle/client-types/model-pools';

/** Where a checked model is configured. */
export type FitSubject = {
  /** 'pool' = a curated shortlist entry; 'worker'/'agent' = a live row that
   *  spends money today. */
  source: 'pool' | 'worker' | 'agent';
  /** Pool id, which for a worker is also its kind (they share a vocabulary). */
  pool: string;
  /** Human label — the curated entry's name, or the worker's name. */
  label: string;
  /** The OpenRouter slug that was checked. */
  model: string;
};

export type FitVerdict =
  | { status: 'fits'; subject: FitSubject }
  | { status: 'misfit'; subject: FitSubject; reason: string }
  | { status: 'unchecked'; subject: FitSubject; reason: string };

export type PoolFitResult = {
  checked: number;
  misfits: FitVerdict[];
  fits: FitVerdict[];
  unchecked: FitVerdict[];
};

/**
 * OpenRouter's meta-routers advertise the UNION of every modality they might
 * route to, which says nothing about the model that actually answers. Same
 * exemption the worker-save guard makes.
 */
export function isRouterSlug(model: string): boolean {
  return /^openrouter\/auto/i.test(model.trim());
}

/**
 * Classify one subject against its pool's modality contract.
 *
 * `modalities: null` means the live catalog does not list the slug (or never
 * loaded). That is absence of evidence, not evidence of a misfit — it comes
 * back `unchecked`, exactly as the write guards fail open. A report that
 * called an unreachable catalog a problem would cry wolf on every offline box.
 */
export function classifyOne(subject: FitSubject, modalities: ModelModalities | null): FitVerdict {
  if (isRouterSlug(subject.model)) {
    return {
      status: 'unchecked',
      subject,
      reason: 'meta-router — modalities are a union over its routes',
    };
  }
  if (!modalities) {
    return { status: 'unchecked', subject, reason: 'not in the live OpenRouter catalog' };
  }
  const reason = poolModelIssue(subject.pool, modalities);
  return reason ? { status: 'misfit', subject, reason } : { status: 'fits', subject };
}

/** Classify every subject and bucket the verdicts. */
export function classifyFits(
  subjects: FitSubject[],
  lookup: (model: string) => ModelModalities | null,
): PoolFitResult {
  const verdicts = subjects.map((s) => classifyOne(s, lookup(s.model)));
  return {
    checked: subjects.length,
    misfits: verdicts.filter((v) => v.status === 'misfit'),
    fits: verdicts.filter((v) => v.status === 'fits'),
    unchecked: verdicts.filter((v) => v.status === 'unchecked'),
  };
}

/** One line for the maintenance run row. Finding a misfit is not a failed
 *  run, so this summarises rather than throws — and always states the
 *  unchecked count, because a clean report over a catalog we could not read
 *  is the misleading half of the truth. */
export function summarisePoolFit(r: PoolFitResult): string {
  const live = r.misfits.filter((v) => v.subject.source !== 'pool').length;
  return (
    `${r.checked} model(s) checked — ${r.misfits.length} misfit(s)` +
    (live ? ` (${live} on a LIVE agent or worker)` : '') +
    `, ${r.fits.length} fine, ${r.unchecked.length} not checked`
  );
}

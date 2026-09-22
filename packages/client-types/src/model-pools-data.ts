/**
 * CURATED MODEL POOLS — the repo-shipped template.
 *
 * GENERATED, by `pnpm -C server/web models:curate --apply --export` run against
 * a live brain (2026-09-22). The ranking is arithmetic over three public
 * datasets — OpenRouter's catalog for what exists, what it costs and what it
 * can DO; Artificial Analysis indices for what scores; OpenRouter's usage
 * rankings for what real traffic trusts. Do NOT hand-edit entries: re-run the
 * task, or curate at /models/pools and re-export with
 * GET /api/model-pools/export.
 *
 * It used to be a conversational pass by the Curator specialist (2026-08-22),
 * which did the job well once and then aged. A month later two of its 97
 * entries pointed at models OpenRouter had delisted — so the `Free` combo
 * picked a reflector that 404s — four carried prices off by up to 5x, and
 * seven vendors had shipped auto-updating `-latest` aliases that no pool
 * offered. A stale shortlist looks exactly like a considered one, which is why
 * re-curation became something you can RUN (and press: the Re-curate button on
 * /models/pools). See server/web/lib/maintenance/curate-pools.ts.
 *
 * Seeded into `curated_models` for owners who have no curated entries yet
 * (fresh installs at onboarding; empty existing brains on upgrade). Owners who
 * have curated ANYTHING are never touched — their pools are their judgment.
 * Pricing snapshots ride along so direct-provider brains render the cost
 * comparison with no OpenRouter dependency.
 *
 * The 96 entries themselves live in ./model-pools-data.json (tier 3 of the
 * 2026-09-02 audit). They are DATA, not code: nothing here was ever read by a
 * human as TypeScript, and 2200 lines of object literals made every re-export
 * a diff no reviewer could scan. JSON is also what the export route emits, so
 * a re-curation is now a file swap rather than a codegen step.
 */

import entries from './model-pools-data.json' with { type: 'json' };

export type CuratedTemplateEntry = {
  pool: string;
  position: number;
  name: string;
  vendor: string | null;
  routes: { provider: string; model: string }[];
  pricing: {
    inputPerM: number | null;
    outputPerM: number | null;
    currency: 'USD';
    capturedAt: string;
    source: string;
  } | null;
  rating: number | null;
  note: string | null;
};

export const CURATED_MODEL_POOLS: readonly CuratedTemplateEntry[] =
  entries as readonly CuratedTemplateEntry[];

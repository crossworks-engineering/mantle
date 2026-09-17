/**
 * CURATED MODEL POOLS — the repo-shipped template.
 *
 * GENERATED from a live curation pass (the Curator specialist on the primary
 * brain, 2026-08-22 incl. the voice-pool re-curation, OpenRouter rankings/benchmarks evidence, prices captured
 * at curation time). Do NOT hand-edit entries here: curate at /models/pools
 * (by hand or via the Curator) and re-export with GET /api/model-pools/export.
 *
 * One hand-correction on 2026-09-02: the vision ("Read images") pool carried
 * Nano Banana Pro (`google/gemini-3-pro-image`), which is an image GENERATOR
 * (`text+image->text+image`). It is out, and `poolModelIssue` in
 * ./model-pools.ts now rejects that class of entry on every write path.
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

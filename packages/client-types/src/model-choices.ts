/**
 * Curated model choices offered in the onboarding "Models" step.
 *
 * PURE DATA — imported by both the onboarding client (cards UI) and the API
 * route (validation), so keep it dependency-free. Lives in system-manifest/
 * because it's product-shipped model policy: the `recommended` entry in each
 * list MUST match the corresponding manifest default (`PERSONA_MANIFEST.model`
 * / the indexing workers' model in `MANIFEST_WORKERS`) — onboarding merely
 * writes the user's pick as operator overlay on top of the manifest seed.
 *
 * Slugs are OpenRouter ids (verified against the live catalog). `azure: true`
 * marks OpenAI-family models that can also be served from an Azure OpenAI
 * deployment (the Azure route strips the `openai/` prefix to form the
 * deployment name). Prices are indicative $/M tokens (in · out) — shown to
 * the user as a class signal, not a quote.
 */
import { CURATED_MODEL_POOLS } from './model-pools-data';

export type ModelChoice = {
  /** OpenRouter model slug (`vendor/model`). */
  id: string;
  /** Display name for the card. */
  name: string;
  /** One-line honest pitch — strengths + who should pick it. */
  blurb: string;
  /** Indicative pricing, e.g. "$3 · $15 /M". */
  price: string;
  /** Deployable on Azure OpenAI (OpenAI-family only). */
  azure?: boolean;
  /** The shipped default — pre-selected, badge on the card. */
  recommended?: boolean;
};

/** Hand-curated head of the assistant list — the recommended entry and the
 *  azure-capable picks carry policy the curated template can't express. The
 *  exported list below extends this with the shipped `agents` pool. */
const BASE_ASSISTANT_CHOICES: readonly ModelChoice[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    blurb:
      'The shipped default — Anthropic’s newest Sonnet: superb reasoning and tool use, 1M context, and cheaper than the generation before it.',
    price: '$2 · $10 /M',
    recommended: true,
  },
  {
    id: 'anthropic/claude-opus-4.8',
    name: 'Claude Opus 4.8',
    blurb:
      'Anthropic’s flagship — the strongest option for hard technical and analytical work. Same class Mantle uses for its app-builder.',
    price: '$5 · $25 /M',
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    blurb:
      'OpenAI’s newest flagship — excellent general intelligence. The top-tier pick that can also run from an Azure OpenAI deployment.',
    price: '$5 · $30 /M',
    azure: true,
  },
  {
    id: 'x-ai/grok-4.20',
    name: 'Grok 4.20',
    blurb:
      'Frontier-class at a budget price — fast and capable, the value pick if cost per conversation matters most.',
    price: '$1.25 · $2.50 /M',
  },
];

/** Fast/cheap choices for the background workers (indexing pipeline: the
 *  extractor, summarizer, reflector, document reader, and narrator). These
 *  process EVERYTHING the brain ingests, so price and speed dominate. */
const BASE_WORKER_CHOICES: readonly ModelChoice[] = [
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    blurb:
      'The shipped default — very fast, very cheap, 1M-token context. Ideal for the always-on indexing that reads everything you add.',
    price: '$0.25 · $1.50 /M',
    recommended: true,
  },
  {
    id: 'openai/gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    blurb:
      'The cheapest capable worker — great throughput on light summarisation. The budget pick on the Azure route.',
    price: '$0.20 · $1.25 /M',
    azure: true,
  },
  {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    blurb:
      'A step up in extraction quality while staying cheap — the stronger Azure-capable worker for dense technical documents.',
    price: '$0.75 · $4.50 /M',
    azure: true,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    blurb:
      'The premium fast model — noticeably sharper summaries and fact extraction, at a higher per-token price than the other workers.',
    price: '$1 · $5 /M',
  },
];

// ── Extend the hand-written heads with the shipped curated template ─────────
// The onboarding step shows (and the API route accepts) the union: policy
// cards first — recommended + azure flags are hand-set and MUST stay — then
// every template model not already present, priced from its snapshot. The
// template ships with the repo (model-pools-data.ts), so new installs offer
// the full curated range with no network call.

function templatePrice(
  p: {
    inputPerM: number | null;
    outputPerM: number | null;
  } | null,
): string {
  if (!p || (p.inputPerM == null && p.outputPerM == null)) return 'price varies';
  if (p.inputPerM === 0 && p.outputPerM === 0) return 'Free';
  const f = (v: number | null) => (v == null ? '?' : `$${v}`);
  return `${f(p.inputPerM)} · ${f(p.outputPerM)} /M`;
}

function extendFromPool(pool: string, base: readonly ModelChoice[]): readonly ModelChoice[] {
  const seen = new Set(base.map((c) => c.id));
  const out: ModelChoice[] = [...base];
  for (const e of CURATED_MODEL_POOLS) {
    if (e.pool !== pool) continue;
    const route = e.routes.find((r) => r.provider === 'openrouter');
    if (!route || seen.has(route.model)) continue;
    seen.add(route.model);
    out.push({
      id: route.model,
      name: e.name,
      blurb: e.note
        ? e.note.charAt(0).toUpperCase() + e.note.slice(1)
        : 'From the shipped curated model pool.',
      price: templatePrice(e.pricing),
    });
  }
  return out;
}

/** Top-tier choices for the assistant: policy head + the curated `agents` pool. */
export const ASSISTANT_MODEL_CHOICES: readonly ModelChoice[] = extendFromPool(
  'agents',
  BASE_ASSISTANT_CHOICES,
);

/** Fast/cheap worker choices: policy head + the curated `summarizer` pool
 *  (the shared workhorse shortlist). */
export const WORKER_MODEL_CHOICES: readonly ModelChoice[] = extendFromPool(
  'summarizer',
  BASE_WORKER_CHOICES,
);

/** Worker kinds the onboarding "worker model" pick applies to — the text
 *  indexing pipeline. Modality workers (tts/stt/vision/image_gen/search)
 *  keep their manifest defaults; they're tuned per-modality in Settings. */
export const WORKER_MODEL_KINDS = [
  'extractor',
  'summarizer',
  'reflector',
  'document',
  'narrator',
  'suggester',
] as const;

/** Azure deployment name for a curated slug (`openai/gpt-5.4` → `gpt-5.4`). */
export function azureDeploymentName(slug: string): string {
  return slug.replace(/^openai\//, '');
}

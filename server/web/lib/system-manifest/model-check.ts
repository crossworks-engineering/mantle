/**
 * The model check: does this box run the shipped default model on each
 * worker and each manifest agent?
 *
 * A worker's or an agent's model is the operator's choice once seeded, and
 * the boot reconcile never overwrites it (CLAUDE.md, "Deliberately NOT
 * auto-propagated"). So a box drifts from the defaults by design, and this
 * says where. It only reports; it never changes a row.
 *
 * Read by GET /api/config/models, the `config_models_check` MCP tool (an
 * admin's own client) and `scripts/fleet-model-check.mjs` (every box of the
 * fleet over ssh, through server/web/scripts/model-check.ts). Pure: the
 * caller loads the rows (model-check-db.ts).
 *
 * Config values only (kind, slug, provider, model id): never a prompt, a
 * key, a base URL or anything a user wrote, so a client box's report is
 * safe to read off the box.
 */
import type { ModelCheckReport, ModelCheckRow, ModelRoute } from '@mantle/client-types';
import {
  MANIFEST_AGENTS,
  MANIFEST_WORKERS,
  type ManifestAgent,
  type ManifestWorker,
} from './manifest';

/** The worker of a kind the runtime runs (getDefaultWorker: the enabled
 *  default, else the top enabled one), as the check reads it. */
export type ModelCheckWorkerRow = {
  kind: string;
  provider: string;
  model: string;
  params?: unknown;
};

export type { ModelCheckReport, ModelCheckRow, ModelRoute };

/** An agent row as the check reads it. */
export type ModelCheckAgentRow = {
  slug: string;
  enabled: boolean;
  provider: string | null;
  model: string;
};

/** The agents' route: every manifest agent is seeded on OpenRouter. */
const AGENT_PROVIDER = 'openrouter';

/** The model ids a params object names: every string value of a key that
 *  ends in `_model`. */
function paramModels(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (k.endsWith('_model') && typeof v === 'string') out[k] = v;
  }
  return out;
}

function routeOf(provider: string, model: string, params?: unknown): ModelRoute {
  const pm = paramModels(params);
  return Object.keys(pm).length ? { provider, model, paramModels: pm } : { provider, model };
}

/** Does the box route equal the default route? Every model id the default
 *  names in its params must match too. */
function sameRoute(box: ModelRoute, def: ModelRoute): boolean {
  if (box.provider !== def.provider || box.model !== def.model) return false;
  for (const [k, v] of Object.entries(def.paramModels ?? {})) {
    if (box.paramModels?.[k] !== v) return false;
  }
  return true;
}

function checkWorker(w: ManifestWorker, rows: readonly ModelCheckWorkerRow[]): ModelCheckRow {
  const def = routeOf(w.provider, w.model, w.params);
  const row = rows.find((r) => r.kind === w.kind);
  const base = { kind: 'worker' as const, name: w.kind, required: w.required, default: def };
  if (!row) return { ...base, status: 'missing', box: null };
  const box = routeOf(row.provider, row.model, row.params);
  const alt = w.altProvider && w.altModel ? routeOf(w.altProvider, w.altModel, w.altParams) : null;
  const ok = sameRoute(box, def) || (alt !== null && sameRoute(box, alt));
  return { ...base, status: ok ? 'ok' : 'drift', box };
}

function checkAgent(a: ManifestAgent, rows: readonly ModelCheckAgentRow[]): ModelCheckRow {
  const def: ModelRoute = { provider: AGENT_PROVIDER, model: a.model };
  const row = rows.find((r) => r.slug === a.slug);
  const base = { kind: 'agent' as const, name: a.slug, default: def };
  if (!row) return { ...base, status: 'missing', box: null };
  const box: ModelRoute = { provider: row.provider ?? AGENT_PROVIDER, model: row.model };
  if (!row.enabled) return { ...base, status: 'off', box };
  return { ...base, status: sameRoute(box, def) ? 'ok' : 'drift', box };
}

/** Check the box's rows against the shipped defaults: every manifest
 *  worker kind, then every manifest agent (the persona first). Pure. */
export function checkModels(
  live: { workers: readonly ModelCheckWorkerRow[]; agents: readonly ModelCheckAgentRow[] },
  manifest: { workers: readonly ManifestWorker[]; agents: readonly ManifestAgent[] } = {
    workers: MANIFEST_WORKERS,
    agents: MANIFEST_AGENTS,
  },
): ModelCheckRow[] {
  return [
    ...manifest.workers.map((w) => checkWorker(w, live.workers)),
    ...manifest.agents.map((a) => checkAgent(a, live.agents)),
  ];
}

/** The report: the rows and how many are not `ok`. */
export function modelCheckReport(rows: ModelCheckRow[], appVersion: string): ModelCheckReport {
  return { appVersion, notOk: rows.filter((r) => r.status !== 'ok').length, rows };
}

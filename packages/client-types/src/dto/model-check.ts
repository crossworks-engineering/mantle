/**
 * The model check (server/web lib/system-manifest/model-check.ts): does a
 * box run the shipped default model on each worker and manifest agent?
 * What GET /api/config/models and the `config_models_check` MCP tool
 * answer, and what scripts/fleet-model-check.mjs prints per box. Config
 * values only (kind, slug, provider, model id). Read-only.
 */

/** One route: provider, model, and the model ids a worker's params name
 *  (a key ending in `_model`, e.g. the Translator's `fallback_model`). */
export type ModelRoute = {
  provider: string;
  model: string;
  paramModels?: Record<string, string>;
};

/**
 * - `ok`: the box runs the default (a worker on its declared alt route, the
 *   xAI voice route, is ok too).
 * - `drift`: the box runs another provider or model: the operator's choice,
 *   or a box set up before the default changed.
 * - `missing`: no row (an agent), or no enabled worker of the kind.
 * - `off`: the agent's row is switched off.
 */
export type ModelCheckStatus = 'ok' | 'drift' | 'missing' | 'off';

export type ModelCheckRow = {
  kind: 'worker' | 'agent';
  /** The worker kind or the agent slug. */
  name: string;
  status: ModelCheckStatus;
  /** A worker the manifest marks required (a missing one is a real gap). */
  required?: boolean;
  /** What the box runs (null when missing). */
  box: ModelRoute | null;
  /** The shipped default. */
  default: ModelRoute;
};

export type ModelCheckReport = {
  appVersion: string;
  /** Rows not `ok`. */
  notOk: number;
  rows: ModelCheckRow[];
};

/**
 * Model check bridge. `config_models_check` reports whether this box runs
 * the shipped default model on each worker and agent, and the check reads
 * the system manifest, which lives in server/web
 * (lib/system-manifest/model-check-db.ts), not in this package. Same shape
 * as services-bridge.ts: the web process installs the provider at boot; a
 * process that never installs one (the runner, the stdio MCP server, the
 * workers) gets a clear refusal instead of a crash.
 */
import type { ModelCheckReport } from '@mantle/client-types';

export type ModelCheckProvider = (ownerId: string) => Promise<ModelCheckReport>;

let provider: ModelCheckProvider | null = null;

export function registerModelCheckProvider(fn: ModelCheckProvider | null): void {
  provider = fn;
}

export function getModelCheckProvider(): ModelCheckProvider | null {
  return provider;
}

/** The refusal a process without the provider gives. */
export const MODEL_CHECK_UNAVAILABLE =
  "No model check here: it runs in this box's web process. Call config_models_check over the box's MCP endpoint (/api/mcp), or GET /api/config/models.";

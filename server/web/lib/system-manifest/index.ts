/**
 * System manifest — the single declarative source of truth for the default
 * agent/skill/tool/worker graph, plus the live config-integrity checker.
 * Server-only (imports @mantle/tools / @mantle/db). See ./manifest.ts.
 */
export * from './manifest';
export { checkSystemIntegrity } from './integrity';
export { resolveEffectivePersona, type PersonaCandidate } from './persona';
export {
  applyManifest,
  seedToolCapabilities,
  seedManifestWorkers,
  adoptManifestItem,
  type ApplyManifestOpts,
  type ApplyManifestResult,
  type ApplyMode,
  type SeedWorkersResult,
  type AdoptKind,
} from './seed';

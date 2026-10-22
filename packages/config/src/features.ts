/**
 * Every feature switch, its source and its default, in one table (A10 #11;
 * docs/configuration.md, "Flags and env"). `feature(name)` is the one
 * reader: an env switch in the one flag dialect (parse.ts), a profile
 * boolean through `profileFlag` (@mantle/client-types/profile-flags), an
 * optional service through `serviceEnabled` (services.ts).
 *
 * Why: the survey (A10 #11) found 7 `isXEnabled()` functions each parsing
 * its own env var, the runs gate checked in five places, and one variable
 * (MANTLE_TURN_STREAMING) read twice with two answers: the SSE route's
 * reader ignored the legacy name its replay buffer honoured. A switch named
 * here has one answer wherever it is read. An `isXEnabled` definition
 * outside this file is a lint error (eslint-rules/env-flags.mjs).
 */
import { PROFILE_FLAGS, profileFlag, type ProfileFlag } from '@mantle/client-types/profile-flags';
import { env, ENV_ALIASES, isProduction, type KnownEnvName } from './index';
import { parseFlag } from './parse';
import { serviceEnabled, type OptionalService } from './services';

type EnvFeature = {
  env: KnownEnvName;
  /** `context`: the caller passes the default (`feature(name, { default })`). */
  default: boolean | 'context';
  /** Always off in production, whatever the variable says. */
  devOnly?: true;
  doc: string;
};
type ProfileFeature = { profile: ProfileFlag; doc: string };
type ServiceFeature = { service: OptionalService; doc: string };
export type FeatureSpec = EnvFeature | ProfileFeature | ServiceFeature;

export const FEATURES = {
  // Environment switches. On by default: only an off word turns them off.
  turnStreaming: {
    env: 'MANTLE_TURN_STREAMING',
    default: true,
    doc: 'live turn stream: the SSE and cancel routes, the non-blocking turn POST, the replay buffer',
  },
  turnTokens: {
    env: 'MANTLE_TURN_TOKENS',
    default: true,
    doc: 'live reply token typing (needs turnStreaming)',
  },
  turnNarration: {
    env: 'MANTLE_TURN_NARRATION',
    default: true,
    doc: 'the per-step narration phrases on the stream (a small model call each)',
  },
  turnSuggestions: {
    env: 'MANTLE_TURN_SUGGESTIONS',
    default: true,
    doc: 'fleet-wide kill switch for the follow-up suggestion (per agent it is opt-in)',
  },
  queryEnrich: {
    env: 'MANTLE_QUERY_ENRICH',
    default: true,
    doc: 'enrich a short retrieval query from the recent conversation',
  },
  mcpToolsmithWrite: {
    env: 'MANTLE_MCP_TOOLSMITH_WRITE',
    default: true,
    doc: 'the MCP surface offers the toolsmith write tools',
  },
  s3ForcePathStyle: {
    env: 'S3_FORCE_PATH_STYLE',
    default: true,
    doc: 'path-style object store URLs',
  },
  // Environment switches. Off by default: only an on word turns them on.
  runs: {
    env: 'MANTLE_RUNS',
    default: false,
    doc: 'runner queues: run_plan / run_append and the runs worker (run_state, run_cancel stay live)',
  },
  viewerRolesPerDatabase: {
    env: 'MANTLE_VIEWER_ROLES_PER_DATABASE',
    default: false,
    doc: 'viewer roles named per database (several brains on one Postgres)',
  },
  dbRuntimeRole: {
    env: 'MANTLE_DB_RUNTIME_ROLE',
    default: false,
    doc: 'the app pools log in as mantle_runtime, not as the migrator (arch A9, docs/runtime-role.md)',
  },
  bootReconcileOff: {
    env: 'MANTLE_DISABLE_BOOT_RECONCILE',
    default: false,
    doc: 'skip the system manifest reconcile at production boot',
  },
  detachedDev: {
    env: 'MANTLE_DETACHED_DEV',
    default: false,
    devOnly: true,
    doc: 'DB-less detached dev: page navigations render without a session',
  },
  crashTest: {
    env: 'MANTLE_CRASH_TEST',
    default: false,
    doc: 'the crash-test harness in server/api',
  },
  // Environment switch whose default the caller knows.
  narrowSystem: {
    env: 'MANTLE_NARROW_SYSTEM',
    default: 'context',
    doc: 'the narrow system route: the asSystem reasons and request exits that pick it run as mantle_system_narrow (default: on in tests and development, off in production; plan v3.2 S7a)',
  },
  mcpTerminal: {
    env: 'MANTLE_MCP_TERMINAL',
    default: 'context',
    doc: 'the MCP surface offers the terminal tools (default: stdio yes, HTTP no)',
  },

  // Profile booleans (the defaults live in PROFILE_FLAGS).
  shareNeat: { profile: 'shareNeat', doc: PROFILE_FLAGS.shareNeat.doc },
  streamThoughts: { profile: 'streamThoughts', doc: PROFILE_FLAGS.streamThoughts.doc },
  persistThoughts: { profile: 'persistThoughts', doc: PROFILE_FLAGS.persistThoughts.doc },
  toolsmithRequireApproval: {
    profile: 'toolsmithRequireApproval',
    doc: PROFILE_FLAGS.toolsmithRequireApproval.doc,
  },
  heartbeatEgressGate: {
    profile: 'heartbeatEgressGate',
    doc: PROFILE_FLAGS.heartbeatEgressGate.doc,
  },
  remoteMcp: { profile: 'remoteMcpEnabled', doc: PROFILE_FLAGS.remoteMcpEnabled.doc },
  teamPrivateReads: { profile: 'teamPrivateReads', doc: PROFILE_FLAGS.teamPrivateReads.doc },

  // Optional services (Settings > Services; services.ts).
  sandboxes: { service: 'sandboxes', doc: 'the sandboxes service (sandboxd)' },
  media: { service: 'media', doc: 'the media sidecar (video_ingest, CAD renders)' },
  localEmbedder: { service: 'local-embedder', doc: 'the bundled local embedder' },
  docHelpers: { service: 'helpers', doc: 'Tika and the PDF browser (always on a full box)' },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureName = keyof typeof FEATURES;
type Spec<K extends FeatureName> = (typeof FEATURES)[K];
export type ProfileFeatureName = {
  [K in FeatureName]: Spec<K> extends { profile: string } ? K : never;
}[FeatureName];
type ContextFeatureName = {
  [K in FeatureName]: Spec<K> extends { default: 'context' } ? K : never;
}[FeatureName];
type PlainFeatureName = Exclude<FeatureName, ProfileFeatureName | ContextFeatureName>;

/** The stored preferences a profile feature reads (any shape that carries
 *  the booleans: a loaded ProfilePreferences, a raw jsonb object). */
export type FeaturePrefs = { readonly [K in ProfileFlag]?: unknown } | null | undefined;

/** Is the feature on? The one reader of every switch in {@link FEATURES}. */
export function feature(name: PlainFeatureName): boolean;
export function feature(name: ProfileFeatureName, ctx: { prefs: FeaturePrefs }): boolean;
export function feature(name: ContextFeatureName, ctx: { default: boolean }): boolean;
export function feature(
  name: FeatureName,
  ctx?: { prefs?: FeaturePrefs; default?: boolean },
): boolean {
  const spec: FeatureSpec = FEATURES[name];
  if ('profile' in spec) return profileFlag(ctx?.prefs, spec.profile);
  if ('service' in spec) return serviceEnabled(spec.service);
  if (spec.devOnly && isProduction()) return false;
  const fallback = spec.default === 'context' ? (ctx?.default ?? false) : spec.default;
  return parseFlag(env(spec.env), fallback);
}

/** Where a feature is read from, for the docs and /debug: the variable (and
 *  its legacy alias), the profile key, or the service. */
export function featureSource(name: FeatureName): string {
  const spec: FeatureSpec = FEATURES[name];
  if ('profile' in spec) return `profile.${spec.profile}`;
  if ('service' in spec) return `service ${spec.service}`;
  const alias = ENV_ALIASES[spec.env];
  return alias ? `${spec.env} (legacy ${alias})` : spec.env;
}

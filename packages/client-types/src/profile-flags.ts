/**
 * The profile booleans and their defaults, in one table (A10 #11;
 * docs/configuration.md, "Flags and env"). A preference the owner never set
 * is absent from the stored jsonb, so every reader has to supply the
 * default; 26 sites did, each with its own `!== false` or `=== true`. Read
 * one with {@link profileFlag}; the brain's preferences loader, its routes
 * and the feature registry (@mantle/config FEATURES) all do.
 *
 * Browser-safe and dependency-free: the client reads the same table.
 */
import type { ProfilePreferences } from './dto/rows';

export type ProfileFlagSpec = { default: boolean; doc: string };

export const PROFILE_FLAGS = {
  shareNeat: { default: true, doc: 'the public /s share reader paints the saved Neat gradient' },
  streamThoughts: { default: true, doc: 'stream the thought trail live while a turn runs' },
  persistThoughts: { default: true, doc: 'keep the thought trail on the finished message' },
  toolsmithRequireApproval: {
    default: false,
    doc: 'a tool an agent authors is confirm-gated until the operator clears it',
  },
  heartbeatEgressGate: {
    default: false,
    doc: "a heartbeat's egress tool calls park for approval",
  },
  remoteMcpEnabled: {
    default: false,
    doc: 'the remote MCP connector and its OAuth endpoints answer',
  },
  teamPrivateReads: {
    default: false,
    doc: "the team responder may read the owner's email and journal",
  },
} as const satisfies { [K in keyof ProfilePreferences]?: ProfileFlagSpec };

export type ProfileFlag = keyof typeof PROFILE_FLAGS;

/** The stored value of one profile boolean, with its default: a default-on
 *  flag is on unless stored `false`, a default-off flag on only when stored
 *  `true` (jsonb can hold anything; nothing else counts). */
export function profileFlag(
  prefs: { readonly [K in ProfileFlag]?: unknown } | null | undefined,
  name: ProfileFlag,
): boolean {
  const v = prefs?.[name];
  return PROFILE_FLAGS[name].default ? v !== false : v === true;
}

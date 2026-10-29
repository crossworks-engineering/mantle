/**
 * The client-sourced write rule a tool's policy declares (`clientSourced`,
 * tool-policy.ts). A leaf: the tool definitions import the rule shapes from
 * here, and the guard that reads them (client-sourced-rules.ts) imports
 * this module's type. The rule lives on the policy: there is no second
 * per-tool registry keyed by name.
 *
 * What a MARKED turn (client-sourced.ts) may do with a write: run it, or
 * send it to the owner's approval. Two parts are not declared here, the
 * policy says them already and the guard derives them:
 *  - a tool whose policy may lower content (`lowering`) is judged by it;
 *  - a create that lands in a folder named by its path (`createsIn`) has
 *    that path checked as a destination, beside any `paths` declared here.
 */

type Input = Record<string, unknown>;

export type ClientSourcedRule =
  /** Writes nothing a client or the public reads. */
  | Readonly<{ kind: 'free'; why: string }>
  /** The target cannot be read from the input: every call waits (or only
   *  those `when` picks). */
  | Readonly<{ kind: 'always'; why: string; when?: (input: Input) => boolean }>
  | ClientSourcedWriteRule;

export type ClientSourcedWriteRule = Readonly<{
  kind: 'write';
  /** Input fields naming the existing nodes it writes into (an id or a
   *  list of ids), destination folders included. A value that is not an
   *  id, or an id of no node of this brain, waits (the check fails
   *  closed). */
  nodes?: readonly string[];
  /** Input fields naming a destination folder by its ltree path, beside
   *  the policy's `createsIn`: what lands there takes the share of a
   *  folder at or above it (folder sharing), so a client-shared one waits.
   *  A path that does not parse waits too. */
  paths?: readonly string[];
  /** Input fields naming agents / tool groups by slug. */
  agents?: readonly string[];
  groups?: readonly string[];
  /** Input fields naming tools by slug: the groups that hold the tool. */
  tools?: readonly string[];
  /** Input fields naming apps by id: the app and the brain tables it
   *  exports (app-table-exports.ts). */
  apps?: readonly string[];
  /** Node ids it writes that depend on another field (a source it
   *  supersedes). */
  extraNodes?: (input: Input) => unknown[];
  /** It makes new nodes: in a marked turn they carry the mark. */
  creates?: true;
  /** When this holds, the target cannot be read from the input and the
   *  call waits (a file overwrite named by path). */
  alwaysWhen?: (input: Input) => boolean;
}>;

const isTrue = (v: unknown) => v === true || v === 'true';

/** The rule shapes, for a definition's `policy.clientSourced`. */
export const CS = Object.freeze({
  /** Writes nothing a client or the public reads, for this reason. */
  free: (why: string): ClientSourcedRule => ({ kind: 'free', why }),
  /** Every call waits, for this reason. */
  always: (why: string): ClientSourcedRule => ({ kind: 'always', why }),
  /** A write into the nodes these input fields name. */
  onNodes: (...fields: string[]): ClientSourcedWriteRule => ({ kind: 'write', nodes: fields }),
  /** A create under the nodes these input fields name (none: anywhere);
   *  the new nodes carry the mark. */
  creates: (...parentFields: string[]): ClientSourcedWriteRule => ({
    kind: 'write',
    nodes: parentFields,
    creates: true,
  }),
  /** A write into the app its `id` names (and the tables it exports). */
  onApp: Object.freeze({ kind: 'write', apps: ['id'] }) as ClientSourcedWriteRule,
  /** The call overwrites an existing file named by its path. */
  overwrites: (input: Input): boolean => isTrue(input.overwrite),
  /** The source a call supersedes, when it asks to (`supersede_source`). */
  supersedes:
    (field: string) =>
    (input: Input): unknown[] =>
      isTrue(input.supersede_source) ? [input[field]].flat() : [],
  READS: 'reads only',
  OUTWARD: 'sends outside the brain (confirm-gated as well)',
  WEB: 'reads the web',
  UNSEEN: 'it runs code or actions whose target its input does not name',
  LATER: "a run's workers act later, outside this turn",
  RECALL_GUIDANCE: "Recall is the owner's guidance to every agent; a card keeps no client mark",
});

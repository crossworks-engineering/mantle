/**
 * The kind registry (workspaces arch plan v2, section 9; A1): ONE entry per
 * value of the `node_type` enum (packages/db/src/schema/nodes.ts). Every other
 * TS kind list is derived from it, never copied:
 *
 *  - WORKSPACE_NODE_TYPES (@mantle/db), the class;
 *  - TREE_KINDS and TREE_KIND_SPECS (./tree), TREE_LIVE_KINDS and
 *    READER_TREE_KINDS (@mantle/content/tree), TREE_TOOL_KINDS
 *    (@mantle/tools), the tree entry;
 *  - SHAREABLE_TYPES and canShareNode, CONTACT_SHAREABLE_TYPES and
 *    PEER_SHAREABLE_TYPES (@mantle/content), the share fields;
 *  - SEARCH_NODE_TYPES (./search-query), searchable;
 *  - TEAM_PRIVATE_CORPUS_TYPES and TEAM_NEVER_TYPES
 *    (@mantle/content-core/profile-projections), teamHidden;
 *  - MEMBER_ITEM_KINDS and CLIENT_ITEM_KINDS (./member-kinds), library: kept
 *    one pair release, then they go with the field;
 *  - the lists of ./kind-lists (A10 #12): extract, corpusMap, contextRef,
 *    embeds, mentionTarget, linkServes, exportAs, accepted, searchTool,
 *    peerPick, documentTitle. A literal list of kind names anywhere else is
 *    an arch count pinned at 0 (eslint-rules/arch-counts.mjs handKindLists);
 *  - what a write re-indexes (A10 #7): `indexed`, read by markContentChanged
 *    (@mantle/db) and indexWorkFor below; a hand re-index anywhere else is
 *    an arch count pinned at 0 (eslint-rules/no-hand-reindex.mjs).
 *
 * Each field holds the value the code had when the registry came in (A1).
 * Who may share or see a kind changes here only as a reviewed diff of the
 * snapshot tests (kinds.test.ts and the tests next to each derived list),
 * never as a side effect of another list.
 *
 * `class` must equal mantle_kind_class(t) in SQL (migration 0241); a db test
 * checks it, and that the enum and these keys are the same set. The keys are
 * in the order of the Drizzle enum (schema/nodes.ts); a list derived here
 * keeps that order unless it says otherwise (the tree lists and the old
 * Library lists keep their own).
 *
 * Pure and dependency free: the `@mantle/client-types/kinds` subpath, so
 * jackdaw reads the same registry.
 */
import type { TreeSort } from './tree';

/** 'workspace': granted to any workspace. 'conversation': belongs to the
 *  workspace of the assistant that holds the chat. 'admin_only': lives in the
 *  Admin workspace only. */
export type KindClass = 'workspace' | 'conversation' | 'admin_only';

/** A kind's place in the item tree. */
export type KindTreeSpec = {
  /** The tree kind (the URL segment, /api/tree/:kind). */
  readonly kind: string;
  /** The ltree root label of the kind (the `*_ROOT_LABEL` constants). */
  readonly root: string;
  /** Navigation order (TREE_KINDS). A jackdaw contract: never reorder. */
  readonly order: number;
  /** The order the brain lists the kinds it serves (TREE_LIVE_KINDS, the
   *  shell's `treeKinds`, the tree tools' enum): apps joined after secrets. */
  readonly liveOrder: number;
  /** The item orders offered, the first being the default. */
  readonly sorts: readonly TreeSort[];
  /** Whether a folder of this kind may be shared below Admin. */
  readonly shareable: boolean;
};

export type KindSpec = {
  readonly class: KindClass;
  readonly tree: KindTreeSpec | null;
  /** May carry a public link (SHAREABLE_TYPES). 'files-folder': a folder,
   *  only strictly under the `files` root (canShareNode). */
  readonly publicLink: boolean | 'files-folder';
  /** May be shared with one contact (CONTACT_SHAREABLE_TYPES). */
  readonly contactShare: boolean;
  /** May be granted to a linked brain by category (PEER_SHAREABLE_TYPES). */
  readonly peerShare: boolean;
  /** A `type` filter of GET /api/search (SEARCH_NODE_TYPES). */
  readonly searchable: boolean;
  /** The kind's item routes: the content prefix (`:id` follows it; the
   *  member route lists are generated from it, route-scope.ts) and the
   *  public API v1 prefix. Null where the kind has none. Nothing reads `v1`
   *  yet: A4 generates the content rows of ROUTE_POLICY from both (plan v2,
   *  section 7; D3, v1 answers as its base route). */
  readonly route: { readonly content: string | null; readonly v1: string | null };
  /** Hidden from a team surface: 'never' (opt-in or not), 'private-corpus'
   *  (unless the owner opted in, teamPrivateReads), or not. */
  readonly teamHidden: 'never' | 'private-corpus' | false;
  /** The old Library lists: in MEMBER_ITEM_KINDS at `order`, and in
   *  CLIENT_ITEM_KINDS too when `client`. Kept one pair release (A1), then
   *  removed with them. */
  readonly library: { readonly order: number; readonly client: boolean } | false;

  // ── A10 #12: the hand kind lists, now fields (./kind-lists derives them).
  // Each holds the value its list had on main v0.300.46 (kind-lists.test.ts
  // RECORDED), except the changes that test names.

  /** The extractor reads it by default (DEFAULT_EXTRACT_TYPES, a worker's
   *  `target_types` overrides), and the integrity view lists it
   *  (LANDED_TYPES). Turning this on for a kind that had it off extracts
   *  that kind's whole corpus: a cost decision, never a tidy-up. */
  readonly extract: boolean;
  /** Listed by title in the responder's corpus map (CORPUS_MAP_TYPES). */
  readonly corpusMap: boolean;
  /** The kind a context ref names it by (the client's vocabulary,
   *  CONTEXT_KINDS: a `branch` is a `folder`), or false. */
  readonly contextRef: string | false;
  /** Embeds other items (node_embeds edges: EMBEDDING_KINDS, the embed
   *  refold). */
  readonly embeds: boolean;
  /** A mention chip may name it (/api/mentions/search). */
  readonly mentionTarget: boolean;
  /** Its public link may serve the items it names or embeds
   *  (link-serve.ts; a folder serves its own items). */
  readonly linkServes: boolean;
  /** Downloads as this format by default (EXPORTABLE_TYPES), or false. */
  readonly exportAs: KindExportFormat | false;
  /** An accepted item: its snapshot is recorded on accept, read back,
   *  served in the Library and copied (forAcceptedKind). `rank`: which of a
   *  bundle's items names it, lowest first (login-notices.ts). */
  readonly accepted: { readonly rank: number } | false;
  /** A `type` value of the search tools (search_nodes, the MCP `search`).
   *  Wider than `searchable` by `secret`: an agent may filter its own
   *  secrets' metadata; the search screen offers no such filter. */
  readonly searchTool: boolean;
  /** Offered by the linked brain grant picker (/api/peers/nodes). */
  readonly peerPick: boolean;
  /** Its title names a document, not a thing the user does (entity-names). */
  readonly documentTitle: boolean;

  // ── A10 #7: what a write re-indexes.

  /** Every field a write of this kind may change, with the index work its
   *  change redoes (markContentChanged, @mantle/db): 'embed', 'extract', or
   *  false (the field feeds no index). A write names the fields it changed;
   *  the most work any of them asks for is done once. Each value holds what
   *  main v0.300.47 did (a10-content-changed.main.json), except the cells
   *  a10-content-changed.changes.json names. Turning a field to 'extract'
   *  makes every save of it a model call: a cost decision, never a tidy-up. */
  readonly indexed: Readonly<Record<string, IndexWork | false>>;
};

/** What a change of an indexed field makes the extractor redo (A10 #7).
 *  'embed': the vector only, rebuilt from the title and the summary the item
 *  keeps (one embedding on the local embedder, no model call; a table also
 *  rebuilds its profile passages, locally). 'extract': the whole pass (the
 *  summary, the vector, facts and entities: one model call). There is no
 *  summary-only pass: the summary and the facts come from one call. */
export type IndexWork = 'embed' | 'extract';

/** The formats a kind downloads as by default. */
export type KindExportFormat = 'docx' | 'xlsx' | 'svg';

const none = { content: null, v1: null } as const;

export const ITEM_KINDS = {
  branch: {
    class: 'workspace',
    tree: null,
    publicLink: 'files-folder',
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: { content: '/api/files/folders', v1: null },
    teamHidden: false,
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: 'folder',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: false,
    documentTitle: false,
    indexed: {},
  },
  email: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: { content: '/api/email/messages', v1: null },
    teamHidden: 'private-corpus',
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: 'email',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {},
  },
  email_thread: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: none,
    teamHidden: 'private-corpus',
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {},
  },
  file: {
    class: 'workspace',
    tree: {
      kind: 'files',
      root: 'files',
      order: 0,
      liveOrder: 0,
      sorts: ['name', 'updated'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: true,
    searchable: true,
    route: { content: '/api/files/files', v1: '/api/v1/files' },
    teamHidden: false,
    library: { order: 4, client: true },
    extract: true,
    corpusMap: true,
    contextRef: 'file',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: { rank: 4 },
    searchTool: true,
    peerPick: true,
    documentTitle: true,
    indexed: { title: 'embed', content: 'extract', indexing: 'extract', tags: false },
  },
  note: {
    class: 'workspace',
    tree: {
      kind: 'notes',
      root: 'notes',
      order: 1,
      liveOrder: 1,
      sorts: ['updated', 'name'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: true,
    searchable: true,
    route: { content: '/api/notes', v1: '/api/v1/notes' },
    teamHidden: false,
    library: { order: 1, client: true },
    extract: true,
    corpusMap: true,
    contextRef: 'note',
    embeds: true,
    mentionTarget: true,
    linkServes: true,
    exportAs: 'docx',
    accepted: { rank: 1 },
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', content: 'extract', tags: false },
  },
  sermon: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: none,
    teamHidden: false,
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: true,
    indexed: {},
  },
  contact: {
    class: 'admin_only',
    tree: {
      kind: 'contacts',
      root: 'contacts',
      order: 9,
      liveOrder: 8,
      sorts: ['name', 'updated'],
      shareable: false,
    },
    publicLink: false,
    contactShare: false,
    peerShare: true,
    searchable: true,
    route: { content: '/api/contacts', v1: '/api/v1/contacts' },
    teamHidden: false,
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: 'contact',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {
      first_name: 'extract',
      last_name: 'extract',
      company: 'extract',
      emails: 'extract',
      description: 'extract',
      country_code: false,
      cell: false,
      tags: false,
    },
  },
  secret: {
    class: 'admin_only',
    tree: {
      kind: 'secrets',
      root: 'secrets',
      order: 10,
      liveOrder: 9,
      sorts: ['name', 'updated'],
      shareable: false,
    },
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: false,
    route: { content: '/api/secrets', v1: null },
    teamHidden: 'never',
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: false,
    documentTitle: false,
    indexed: {
      title: 'extract',
      description: 'extract',
      kind: 'extract',
      tags: 'extract',
      sealed: false,
    },
  },
  task: {
    class: 'workspace',
    tree: {
      kind: 'tasks',
      root: 'tasks',
      order: 7,
      liveOrder: 6,
      sorts: ['due', 'updated', 'name'],
      shareable: false,
    },
    publicLink: true,
    contactShare: false,
    peerShare: true,
    searchable: true,
    route: { content: '/api/tasks', v1: '/api/v1/tasks' },
    teamHidden: false,
    library: false,
    extract: true,
    corpusMap: true,
    contextRef: 'task',
    embeds: false,
    mentionTarget: false,
    linkServes: true,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {
      title: 'extract',
      body: 'extract',
      status: 'extract',
      priority: 'extract',
      due_at: 'extract',
      todos: 'extract',
      reviewed: 'extract',
      archived_at: false,
      rank: false,
      tags: false,
    },
  },
  event: {
    class: 'workspace',
    tree: {
      kind: 'events',
      root: 'events',
      order: 8,
      liveOrder: 7,
      sorts: ['start', 'name'],
      shareable: false,
    },
    publicLink: true,
    contactShare: false,
    peerShare: true,
    searchable: true,
    route: { content: '/api/events', v1: '/api/v1/events' },
    teamHidden: false,
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: 'event',
    embeds: false,
    mentionTarget: false,
    linkServes: true,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {
      title: 'extract',
      body: 'extract',
      starts_at: 'extract',
      ends_at: 'extract',
      location: 'extract',
      recur: false,
      remind: false,
      timezone: false,
      tags: false,
    },
  },
  printer_project: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: none,
    teamHidden: false,
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {},
  },
  telegram_message: {
    class: 'conversation',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: none,
    teamHidden: 'never',
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: {},
  },
  page: {
    class: 'workspace',
    tree: {
      kind: 'pages',
      root: 'pages',
      order: 2,
      liveOrder: 2,
      sorts: ['updated', 'name'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: true,
    searchable: true,
    route: { content: '/api/pages', v1: '/api/v1/pages' },
    teamHidden: false,
    library: { order: 0, client: true },
    extract: true,
    corpusMap: true,
    contextRef: 'page',
    embeds: true,
    mentionTarget: true,
    linkServes: true,
    exportAs: 'docx',
    accepted: { rank: 0 },
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', doc: 'extract', look: false, tags: false },
  },
  table: {
    class: 'workspace',
    tree: {
      kind: 'tables',
      root: 'tables',
      order: 4,
      liveOrder: 4,
      sorts: ['updated', 'name'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: true,
    searchable: false,
    route: { content: '/api/tables', v1: '/api/v1/tables' },
    teamHidden: false,
    library: { order: 3, client: false },
    extract: true,
    corpusMap: true,
    contextRef: 'table',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: 'xlsx',
    accepted: { rank: 2 },
    searchTool: false,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', cells: 'embed', schema: 'extract', look: false, tags: false },
  },
  mantle_peer: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: false,
    route: none,
    teamHidden: 'never',
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: false,
    peerPick: false,
    documentTitle: false,
    indexed: {},
  },
  documentation: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: { content: '/api/docs/reader', v1: null },
    teamHidden: false,
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: true,
    indexed: { content: 'extract' },
  },
  journal: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: true,
    route: { content: '/api/journal', v1: '/api/v1/journal' },
    teamHidden: 'private-corpus',
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: 'journal',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', body: 'extract', kind: false, entry_date: false, tags: false },
  },
  location: {
    class: 'admin_only',
    tree: null,
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: false,
    route: none,
    teamHidden: 'never',
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: false,
    peerPick: true,
    documentTitle: false,
    indexed: {
      title: 'embed',
      body: 'extract',
      address: 'extract',
      coordinates: false,
      source: false,
      tags: false,
    },
  },
  app: {
    class: 'workspace',
    tree: {
      kind: 'apps',
      root: 'apps',
      order: 6,
      liveOrder: 10,
      sorts: ['name', 'updated'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: false,
    searchable: false,
    route: { content: '/api/apps', v1: null },
    teamHidden: false,
    library: false,
    extract: false,
    corpusMap: true,
    contextRef: 'app',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: false,
    peerPick: true,
    documentTitle: false,
    indexed: { source: 'extract' },
  },
  formula: {
    class: 'workspace',
    tree: {
      kind: 'formulas',
      root: 'formulas',
      order: 5,
      liveOrder: 5,
      sorts: ['name', 'updated'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: false,
    searchable: true,
    route: { content: '/api/formulas', v1: null },
    teamHidden: false,
    library: false,
    extract: true,
    corpusMap: false,
    contextRef: 'formula',
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', spec: 'extract', tags: false },
  },
  draw: {
    class: 'workspace',
    tree: {
      kind: 'draw',
      root: 'draw',
      order: 3,
      liveOrder: 3,
      sorts: ['updated', 'name'],
      shareable: true,
    },
    publicLink: true,
    contactShare: true,
    peerShare: true,
    searchable: true,
    route: { content: '/api/draws', v1: null },
    teamHidden: false,
    library: { order: 2, client: false },
    extract: true,
    corpusMap: false,
    contextRef: 'draw',
    embeds: true,
    mentionTarget: true,
    linkServes: true,
    exportAs: 'svg',
    accepted: { rank: 3 },
    searchTool: true,
    peerPick: true,
    documentTitle: false,
    indexed: { title: 'embed', scene: 'extract', look: false, tags: false },
  },
  recall: {
    class: 'workspace',
    // The tree lists maps only; a map's cards are recall_nodes rows, never
    // nodes. Its folders are not shared below Admin yet (Recall R6).
    tree: {
      kind: 'recall',
      root: 'recall',
      order: 11,
      liveOrder: 11,
      sorts: ['name', 'updated'],
      shareable: false,
    },
    publicLink: false,
    contactShare: false,
    peerShare: false,
    searchable: false,
    // A native map's id is its node's id (createRecallMap).
    route: { content: '/api/recall/maps', v1: null },
    teamHidden: false,
    library: false,
    extract: false,
    corpusMap: false,
    contextRef: false,
    embeds: false,
    mentionTarget: false,
    linkServes: false,
    exportAs: false,
    accepted: false,
    searchTool: false,
    peerPick: true,
    documentTitle: false,
    indexed: {},
  },
} as const satisfies Record<string, KindSpec>;

type Kinds = typeof ITEM_KINDS;

/** Every node type, as the registry names it (the `node_type` enum). */
export type ItemKind = keyof Kinds;

/** The registry keys, in the Drizzle enum's order. */
export const ITEM_KIND_NAMES = Object.keys(ITEM_KINDS) as ItemKind[];

/** The node types whose spec matches `P` (a type-level filter). */
export type KindsWhere<P> = { [K in ItemKind]: Kinds[K] extends P ? K : never }[ItemKind];

/** The node types whose spec passes `pick`, in registry order. Never empty for
 *  the lists derived here (their snapshot tests say so). */
export function kindsWhere<K extends ItemKind = ItemKind>(
  pick: (spec: KindSpec, type: ItemKind) => boolean,
): readonly [K, ...K[]] {
  return ITEM_KIND_NAMES.filter((t) => pick(ITEM_KINDS[t], t)) as unknown as readonly [K, ...K[]];
}

/** The spec of `type`, or null for a value the registry does not know. */
export function kindSpecOf(type: string): KindSpec | null {
  return Object.prototype.hasOwnProperty.call(ITEM_KINDS, type)
    ? ITEM_KINDS[type as ItemKind]
    : null;
}

/** The class of `type` (mantle_kind_class in TS); an unknown value is
 *  'admin_only', as the SQL's ELSE. */
export function kindClassOf(type: string): KindClass {
  return kindSpecOf(type)?.class ?? 'admin_only';
}

// ── Typed selections the derived lists use ──────────────────────────────────

export type WorkspaceKind = KindsWhere<{ class: 'workspace' }>;
export type PublicLinkKind = KindsWhere<{ publicLink: true | 'files-folder' }>;
export type ContactShareKind = KindsWhere<{ contactShare: true }>;
export type PeerShareKind = KindsWhere<{ peerShare: true }>;
export type SearchableKind = KindsWhere<{ searchable: true }>;
export type MemberLibraryKind = KindsWhere<{ library: { order: number } }>;
export type ClientLibraryKind = KindsWhere<{ library: { client: true } }>;
export type ExtractKind = KindsWhere<{ extract: true }>;
export type CorpusMapKind = KindsWhere<{ corpusMap: true }>;
export type EmbeddingKind = KindsWhere<{ embeds: true }>;
export type MentionTargetKind = KindsWhere<{ mentionTarget: true }>;
export type LinkServeKind = KindsWhere<{ linkServes: true }>;
export type ExportKind = KindsWhere<{ exportAs: KindExportFormat }>;
export type AcceptedKind = KindsWhere<{ accepted: { rank: number } }>;
export type SearchToolKind = KindsWhere<{ searchTool: true }>;

/** The context ref kinds the registry names (`folder`, `file`, ...). */
export type ContextRefKind = {
  [K in ItemKind]: Kinds[K]['contextRef'] extends string ? Kinds[K]['contextRef'] : never;
}[ItemKind];

/** The tree kinds the registry names (`files`, `notes`, ...). */
export type RegistryTreeKind = {
  [K in ItemKind]: Kinds[K]['tree'] extends { kind: infer T } ? T : never;
}[ItemKind];

/** The node types with a tree entry, ordered by `key` of that entry. */
export function treeKindsBy(key: 'order' | 'liveOrder'): readonly RegistryTreeKind[] {
  return ITEM_KIND_NAMES.flatMap((t) => {
    const tree: KindTreeSpec | null = ITEM_KINDS[t].tree;
    return tree ? [tree] : [];
  })
    .sort((a, b) => a[key] - b[key])
    .map((t) => t.kind as RegistryTreeKind);
}

// ── A10 #7: what a write re-indexes ─────────────────────────────────────────

/** The fields a write of kind `K` may name (its `indexed` keys). */
export type IndexedField<K extends ItemKind> = keyof Kinds[K]['indexed'] & string;

/** The most work any of `fields` asks of an item of `type` (the registry's
 *  `indexed`), or null when none feeds its index. A field the kind does not
 *  name asks for nothing. */
export function indexWorkFor(type: string, fields: readonly string[]): IndexWork | null {
  const indexed: Readonly<Record<string, IndexWork | false>> = kindSpecOf(type)?.indexed ?? {};
  let work: IndexWork | null = null;
  for (const f of fields) {
    const w = Object.prototype.hasOwnProperty.call(indexed, f) ? indexed[f] : false;
    if (w === 'extract') return 'extract';
    if (w === 'embed') work = 'embed';
  }
  return work;
}

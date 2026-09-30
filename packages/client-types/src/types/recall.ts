/**
 * Wire shapes for the owner Recall API (roadmap tasks 073b322d / 91c93428;
 * docs/recall.md in the mantle repo). Dates are ISO strings.
 *
 * ── Two kinds of map ───────────────────────────────────────────────────────
 * v1 maps are COMPILED from a page tree: the rows are a build artifact, and a
 * card's `id` is its source page's node id, so every row is a click-through to
 * the page editor. v2 maps are NATIVE: the map is one `recall` item in the
 * tree, its cards are rows written directly, and a card's `id` is its own —
 * NOT a page. A client must not link a card to the page editor unless the map
 * is page-built, which `nodeId === null` tells it.
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 * Everything v2 adds here is additive, so a client written against the v1
 * shapes keeps compiling and keeps working against a v1 map.
 *
 * Whether a brain can serve the native path at all is `features.recallV2` from
 * `GET /api/shell`, absent on an older brain. Branch the SCREEN on that, not
 * on the shapes below.
 */

export type RecallLintSeverity = 'error' | 'warning';

/** One issue from a map's last compile report (v1), or one warning from a
 *  native write (v2). */
export interface RecallLintIssueDTO {
  severity: RecallLintSeverity;
  code: string;
  message: string;
  /** v1 only: the page the issue is about — the page-editor click-through. */
  pageId?: string;
  /** v2: the card the warning is about, by slug. A native map has no pages,
   *  and a write that fails a CHECK is refused rather than reported here —
   *  so on a native map these are only ever warnings (an orphan card, an
   *  entry card with no options yet). */
  cardSlug?: string;
}

/** One map in the catalog (`GET /api/recall/maps`). Unlike the agent-facing
 *  `recall_index`, the owner catalog includes never-compiled maps
 *  (`nodeCount` 0) — a failed compile is exactly what the owner must see. */
export interface RecallMapSummaryDTO {
  /** v1: the map root page's node id — a map IS its root page. v2: the map's
   *  own id, which equals `nodeId`. Either way this is what the other Recall
   *  routes take as `:id`. */
  id: string;
  slug: string;
  title: string;
  /** The catalog line: when an agent should enter this map. */
  enterWhen: string;
  /** Card count; 0 = a v1 map that never compiled clean. */
  nodeCount: number;
  /** v1 only: false = the served rows are one rev behind the pages, and
   *  `report` says why. Always true for a native map, which cannot be stale:
   *  its rows are the source, and a write that fails its checks is refused. */
  lastCompileOk: boolean;
  /** v2: the map's `recall` item in the tree. NULL means this map is still
   *  page-built, which is also the flag for "link its cards to the page
   *  editor". */
  nodeId: string | null;
  /** v2: where the owner filed it, as display crumbs ("Mantle / Fleet");
   *  null when unsorted or page-built. Derived from the item's folder, so it
   *  is a label to show, never something to write back. */
  folder: string | null;
  /** v2: false while a map an AGENT created waits for the owner to publish
   *  it. An unpublished map is invisible to every agent-facing tool, so the
   *  owner UI is the only place it can be seen — show it as a draft. */
  published: boolean;
  /** v2: optimistic-concurrency token. Send it back on a write; a stale one
   *  is refused rather than silently overwriting someone else's edit. */
  version: number;
  updatedAt: string;
}

/** One routing edge: an affordance ("use when …"), never a command. */
export interface RecallOptionDTO {
  label: string;
  useWhen: string;
  /** Slug of the target card, within this map unless `targetMap` is set. */
  targetSlug: string;
  /** v2: the target card's id. Draw the graph from this, not from the slug —
   *  it survives a rename. Absent on a v1-compiled row. */
  targetId?: string;
  /** v2: a CROSS-MAP option. The slug of another published map, whose entry
   *  card this option leads to. Absent for an ordinary same-map edge. */
  targetMap?: string;
}

export interface RecallNodeDTO {
  /** v1: the source page's node id, the page-editor click-through target.
   *  v2: the card's own id. It is NOT a page — see the file header. */
  id: string;
  slug: string;
  kind: 'index' | 'knowledge' | 'prompt';
  title: string;
  /** Prompts: the matcher line; empty elsewhere. */
  useWhen: string;
  /** Body size in characters (the budget is enforced on the write). The body
   *  itself is not in the list shape: a 100-card map would put most of a
   *  megabyte on the wire to render a sidebar. Fetch one card to edit it. */
  bodyChars: number;
  options: RecallOptionDTO[];
  /** v1: the `pages.version` this row was compiled from. v2: the map version
   *  the card was written at. */
  sourceVersion: number;
  /** v2: the card's order in the editor. The list arrives sorted by it. */
  rank: number;
  /** v2: an AGENT asked for this card to be a prompt and the owner has not
   *  confirmed. Until they do it is not embedded and never matches, so show
   *  it as a request rather than as a prompt. */
  promptPending: boolean;
  updatedAt: string;
}

/** One card with its body — `GET /api/recall/maps/:id/cards/:cardId`, what
 *  the editor opens. Separate from the list shape on purpose (see
 *  `bodyChars`). */
export interface RecallCardDetailDTO extends RecallNodeDTO {
  /** The markdown the owner edits, at most RECALL_BODY_CHAR_BUDGET characters
   *  (`@mantle/content-core/recall-compile`). */
  bodyMd: string;
}

/** The caps a card and a map are held to are NOT redefined here: they already
 *  live in `@mantle/content-core/recall-compile`, which clients also consume —
 *  `RECALL_BODY_CHAR_BUDGET` (6000 characters of body) and
 *  `RECALL_MAX_MAP_NODES` (100 cards). The editor's counter and the brain's
 *  write check must read the same constant, or the counter promises room the
 *  write refuses. */

/** `GET /api/recall/maps/:id` — the whole compiled map, index node first,
 *  plus the last lint report (null when the last compile was clean). */
export interface RecallMapDetailDTO extends RecallMapSummaryDTO {
  report: RecallLintIssueDTO[] | null;
  nodes: RecallNodeDTO[];
}

/** `GET /api/recall/pages/:id` — this page's place in Recall, if any. Backs
 *  the editor lint badge: the compiler never blocks a commit, so this badge
 *  is the ONLY place an author learns the map is serving a stale rev.
 *  `node` is null when the page is named in a failing report but has no
 *  compiled row yet (a brand-new page that broke the map). */
export interface RecallPageStateDTO {
  map: RecallMapSummaryDTO;
  node: { slug: string; kind: RecallNodeDTO['kind'] } | null;
  report: RecallLintIssueDTO[] | null;
}

// ── v2: the write side ───────────────────────────────────────────────────────
// The owner routes the Recall editor calls. Every write carries the map
// `version` it was made against; a stale one is refused rather than silently
// overwriting another editor's (or an agent's) change. Nothing here exists on
// a v1 map: the page editor is its authoring surface.

/** Who made a change. An `agent` row is why the revision log exists: v2 serves
 *  an agent's card edit immediately, with no compile step to hold it back. */
export type RecallActorKind = 'owner' | 'agent';

/** `POST /api/recall/maps` — a new map, with its entry card. Created
 *  unpublished when an agent asks; the owner publishes it. */
export interface RecallMapCreateDTO {
  title: string;
  /** The catalog line: when an agent should enter this map. */
  enterWhen: string;
  /** Folder crumbs to file it under ("Mantle / Fleet"), or omit for unsorted.
   *  Folders must already exist; this does not create them. */
  folder?: string;
}

/** `PATCH /api/recall/maps/:id` — only the fields present are changed.
 *  Renaming does NOT change the slug: agents and skills remember slugs. */
export interface RecallMapPatchDTO {
  title?: string;
  enterWhen?: string;
  /** An explicit slug change. The old slug is kept and keeps resolving. */
  slug?: string;
  /** Publish (or unpublish) the map. Publishing is what makes it visible to
   *  every agent-facing tool. */
  published?: boolean;
  version: number;
}

/** `PUT /api/recall/maps/:id/cards/:cardId` — create or replace one card.
 *  `options` replaces the card's whole list, so read-modify-write it. */
export interface RecallCardWriteDTO {
  title: string;
  /** Markdown, at most RECALL_BODY_CHAR_BUDGET characters. */
  bodyMd: string;
  /** The matcher line. Required when `prompt` is true: a prompt without one
   *  cannot be matched by meaning, which is the only thing prompts are for. */
  useWhen?: string;
  /** Ask for this card to be a prompt. From the OWNER this makes it one; from
   *  an agent it only records the request (`promptPending`). */
  prompt?: boolean;
  options?: RecallOptionDTO[];
  /** Slug of the card to place this one after, for a new card. */
  after?: string;
  version: number;
}

/** What a write answers with. The warnings are advisory and never block: an
 *  orphan card is a normal intermediate state while a map is being built. */
export interface RecallWriteResultDTO {
  /** The map's new version — carry it into the next write. */
  version: number;
  /** The card written, absent for a map-level write. */
  card?: RecallCardDetailDTO;
  warnings: RecallLintIssueDTO[];
  /** Cards whose options pointed at a card this write deleted, and so had
   *  that option removed in the same transaction. */
  optionsDropped?: { cardSlug: string; label: string }[];
}

/** One entry in a map's revision log (`GET /api/recall/maps/:id/revisions`),
 *  newest first. Restore one with `POST /api/recall/revisions/:id/restore`. */
export interface RecallRevisionDTO {
  id: string;
  /** The card this touched; null for a map-level change. */
  cardId: string | null;
  /** The card's slug at the time, for display when the card is gone. */
  cardSlug: string | null;
  actorKind: RecallActorKind;
  /** The agent's slug or the admin's display name, when known. */
  actorName: string | null;
  /** One line on what changed ("body edited", "card added", "published"). */
  summary: string;
  createdAt: string;
}

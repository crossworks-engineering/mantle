/**
 * Wire shapes for the owner Recall API (roadmap tasks 073b322d / 91c93428;
 * docs/recall.md in the mantle repo). Dates are ISO strings.
 *
 * A map is one `recall` item in the tree; its cards are rows written
 * directly, and a card's `id` is its own, NOT a page. (Page-built v1 maps,
 * compiled from a page tree, were retired in R5: the compile report, the
 * page state route and `lastCompileOk` went with them.)
 *
 * Plan: "PLAN: Recall v2, its own content type" (dev brain, task 5d6ce06a).
 *
 * Whether a brain can serve Recall at all is `features.recallV2` from
 * `GET /api/shell`, absent on a brain older than v2. Branch the SCREEN on
 * that, not on the shapes below.
 */

/** One map in the catalog (`GET /api/recall/maps`). Unlike the agent-facing
 *  `recall_index`, the owner catalog includes unpublished maps and maps with
 *  no cards yet. */
export interface RecallMapSummaryDTO {
  /** The map's id, which equals `nodeId`. This is what the other Recall
   *  routes take as `:id`. */
  id: string;
  slug: string;
  title: string;
  /** The catalog line: when an agent should enter this map. */
  enterWhen: string;
  /** Card count. */
  nodeCount: number;
  /** The map's `recall` item in the tree. (It was null for a page-built map
   *  before R5; a brain on R5 or later never serves one.) */
  nodeId: string;
  /** v2: where the owner filed it, as display crumbs ("Mantle / Fleet");
   *  null when unsorted. Derived from the item's folder, so it is a label to
   *  show, never something to write back. */
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
   *  it survives a rename. */
  targetId?: string;
  /** v2: a CROSS-MAP option. The slug of another published map, whose entry
   *  card this option leads to. Absent for an ordinary same-map edge. */
  targetMap?: string;
}

export interface RecallNodeDTO {
  /** The card's own id. It is NOT a page — see the file header. */
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
  /** The map version the card was written at. */
  sourceVersion: number;
  /** v2: the card's order in the editor. The list arrives sorted by it. */
  rank: number;
  /** v2: an AGENT asked for this card to be a prompt and the owner has not
   *  confirmed. Until they do it is not embedded and never matches, so show
   *  it as a request rather than as a prompt. */
  promptPending: boolean;
  updatedAt: string;
}

/** One card with its body, `GET /api/recall/maps/:id/cards/:slug`: what
 *  the editor opens. A slug the card had before an explicit slug change still
 *  finds it. Separate from the list shape on purpose (see `bodyChars`). */
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

/** `GET /api/recall/maps/:id` — the whole map, its cards in rank order
 *  (the entry card is rank 0). */
export interface RecallMapDetailDTO extends RecallMapSummaryDTO {
  nodes: RecallNodeDTO[];
}

// ── v2: the write side ───────────────────────────────────────────────────────
// The owner routes the Recall editor calls. Every write carries the map
// `version` it was made against; a stale one is refused rather than silently
// overwriting another editor's (or an agent's) change.

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

/** `POST /api/recall/maps` answers 201 with this. An owner-created map is
 *  published at once; only an agent's starts as a draft. */
export interface RecallMapCreateResultDTO {
  mapId: string;
  slug: string;
  version: number;
  published: boolean;
}

/** The body of every refused Recall write. `error` is a sentence written to be
 *  shown as is: what failed and what to do. `code` is stable and absent only on
 *  a malformed request (a body that failed validation). A stale `version` is
 *  409 with code `version_stale`; `map_not_found`, `card_not_found` and
 *  `revision_not_found` are 404; every other refusal is 400, including a bad
 *  reference inside the body (`cross_map_not_found`, `folder_not_found`) and a
 *  revision that has nothing to put back (`revision_not_restorable`). */
export interface RecallWriteErrorDTO {
  error: string;
  code?: string;
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

/** A card write. `POST /api/recall/maps/:id/cards` adds one;
 *  `PUT /api/recall/maps/:id/cards/:slug` replaces an existing one (an unknown
 *  slug is 404, not a create).
 *
 *  `title` and `bodyMd` always replace. `useWhen`, `options` and `prompt` are
 *  STICKY on a replace: leave one out and the card keeps its value. So send
 *  `prompt` only when the owner changed the Prompt switch: a save that sends
 *  `prompt: false` for a card with a pending request drops the request. When
 *  `options` is sent it replaces the card's whole list: read-modify-write it. */
export interface RecallCardWriteDTO {
  title: string;
  /** Markdown, at most RECALL_BODY_CHAR_BUDGET characters. */
  bodyMd: string;
  /** The matcher line. Required when the card is or asks to be a prompt: a
   *  prompt without one cannot be matched by meaning, which is the only thing
   *  prompts are for. */
  useWhen?: string;
  /** From the OWNER: true makes the card a prompt (confirming any pending
   *  request), false makes it knowledge (demoting a prompt, or dropping a
   *  request). From an agent, true only records a request (`promptPending`). */
  prompt?: boolean;
  options?: RecallOptionDTO[];
  /** POST only: the slug of the card to place the new one after. A slug that
   *  names no card is refused (`after_not_found`). */
  after?: string;
  /** PUT only, owner only: an explicit slug change. The old slug keeps
   *  resolving (recall_go, the card GET), and options in this map that led to
   *  it follow the card. */
  slug?: string;
  version: number;
}

/** One advisory warning from a native write. Never blocks: an orphan card is
 *  a normal intermediate state while a map is being built. No `severity`,
 *  because a native write has only one kind of issue it reports rather than
 *  refuses. Codes today: `orphan_card`, `entry_without_options`,
 *  `cross_map_target_gone` (an option to a map no longer published, hidden
 *  from agents), `prompt_kept` (an agent tried to demote a prompt). */
export interface RecallWarningDTO {
  code: string;
  message: string;
  /** The card the warning is about, when it is about one. */
  cardSlug?: string;
}

/** What a write answers with. */
export interface RecallWriteResultDTO {
  /** The map's new version. Carry it into the next write. */
  version: number;
  /** The slug of the card written, absent for a map-level write. The body is
   *  not echoed back: GET the card if the editor needs it again. */
  cardSlug?: string;
  warnings: RecallWarningDTO[];
  /** Cards whose options pointed at a card this write deleted, and so had
   *  that option removed in the same transaction. */
  optionsDropped?: { cardSlug: string; label: string }[];
}

/** One entry in a map's revision log (`GET /api/recall/maps/:id/revisions`),
 *  newest first. Restore one with `POST /api/recall/revisions/:id/restore`,
 *  which puts back what that write replaced: a card's content (and its slug,
 *  if that write moved it); a deleted card under its old slug, at its old
 *  place, with the options other cards had to it; the old order for a
 *  reorder; the map fields that write changed. Undoing "card added" deletes
 *  the card. "map created" cannot be restored (`revision_not_restorable`), nor
 *  can a reorder logged before its old order was kept. */
export interface RecallRevisionDTO {
  id: string;
  /** The card this touched; null for a map-level change. */
  cardId: string | null;
  /** The card's slug at the time, for display when the card is gone. */
  cardSlug: string | null;
  actorKind: RecallActorKind;
  /** The agent's slug, 'mcp' for an external MCP client, or the admin's
   *  display name, stored with the revision. Null on rows written before
   *  brain v0.232.357. */
  actorName: string | null;
  /** One line on what changed: "card added", "card edited", "card deleted",
   *  "cards reordered", "prompt confirmed", "renamed, published", and so on. */
  summary: string;
  createdAt: string;
}

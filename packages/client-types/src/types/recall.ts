/**
 * Wire shapes for the owner Recall API (`GET /api/recall/maps`,
 * `GET /api/recall/maps/:id`) — the read side of the Recall UI (roadmap
 * tasks 073b322d / 91c93428; docs/recall.md in the mantle repo).
 *
 * These describe the COMPILED serving layer (recall_maps / recall_nodes),
 * not the source pages: node `id` is the source page's node id, so every
 * row is a click-through to the page editor. Dates are ISO strings.
 */

export type RecallLintSeverity = 'error' | 'warning';

/** One issue from a map's last compile report. */
export interface RecallLintIssueDTO {
  severity: RecallLintSeverity;
  code: string;
  message: string;
  /** The page the issue is about — the editor click-through target. */
  pageId?: string;
}

/** One map in the catalog (`GET /api/recall/maps`). Unlike the agent-facing
 *  `recall_index`, the owner catalog includes never-compiled maps
 *  (`nodeCount` 0) — a failed compile is exactly what the owner must see. */
export interface RecallMapSummaryDTO {
  /** The map root page's node id — a map IS its root page. */
  id: string;
  slug: string;
  title: string;
  /** The catalog line: when an agent should enter this map. */
  enterWhen: string;
  /** Compiled node count; 0 = never compiled clean. */
  nodeCount: number;
  /** False = the served rows are one rev behind the pages; `report` says why. */
  lastCompileOk: boolean;
  updatedAt: string;
}

/** One routing edge as compiled: an affordance ("use when …"), never a command. */
export interface RecallOptionDTO {
  label: string;
  useWhen: string;
  /** Slug of the target node within the same map. */
  targetSlug: string;
}

export interface RecallNodeDTO {
  /** The source page's node id — the editor click-through target. */
  id: string;
  slug: string;
  kind: 'index' | 'knowledge' | 'prompt';
  title: string;
  /** Prompts: the matcher line; empty elsewhere. */
  useWhen: string;
  /** Rendered-markdown body size (the budget is enforced at compile). */
  bodyChars: number;
  options: RecallOptionDTO[];
  /** `pages.version` this row was compiled from — staleness at a glance. */
  sourceVersion: number;
  updatedAt: string;
}

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

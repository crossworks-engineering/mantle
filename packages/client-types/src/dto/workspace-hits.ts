/**
 * Search across workspaces (docs/folder-tree.md). A search (GET
 * /api/search, and GET /api/tree/:kind/search asked with `across=1`) looks
 * in every workspace the caller reads, not only the one picked in the
 * switcher. The database's row rules decide what the caller reads; the
 * switcher's workspace (`ws`) only orders the hits: its own come first.
 * Each hit names the workspace it opens in, so a client tags a hit from
 * another workspace and switches there before it opens it.
 *
 * Every field here is optional on the wire: a brain before it sends none,
 * and a client then shows no tag and does not switch.
 */

/** The workspace a hit opens in: a live workspace the caller is a user of
 *  that reads the item. The switcher's workspace when it reads the item,
 *  else the item's home when the caller is a user of it, else the first by
 *  name. Absent when the caller is in no such workspace (a read on the
 *  system pool). */
export type HitWorkspace = { id: string; name: string };

/** What a search hit carries beside its own fields. */
export type HitWorkspaceField = { workspace?: HitWorkspace };

/** Items of one folder that another workspace of the caller reads (GET
 *  /api/tree/:kind asked with `ws`, `elsewhere`): `count` items there, none
 *  of them read by the switcher's workspace. */
export type ElsewhereCount = { id: string; name: string; count: number };

/** One row of GET /api/search (nodes mode). */
export type SearchNodeHit = HitWorkspaceField & {
  id: string;
  type: string;
  title: string | null;
  path: string | null;
  tags: string[];
  summary: string | null;
  updatedAt: string;
  url: string;
  supersededBy?: { id: string; title: string | null; url: string };
};

/** One row of GET /api/search?mode=chunks (passages). */
export type SearchChunkHit = HitWorkspaceField & {
  nodeId: string;
  nodeTitle: string | null;
  nodeType: string;
  ordinal: number;
  heading: string | null;
  text: string;
  url: string;
  supersededBy?: { id: string; title: string | null; url: string };
};

/** GET /api/search?q=&mode=&ws=. `ws` (the switcher's workspace) never
 *  narrows a search: the hits that workspace reads come first, and it is
 *  echoed back. A workspace the caller may not name answers 404
 *  `{ error, code: 'not_found' }`, as the lists do. */
export type SearchApiResponse =
  | { mode: 'nodes'; results: SearchNodeHit[]; ws?: string }
  | { mode: 'chunks'; results: SearchChunkHit[]; ws?: string };

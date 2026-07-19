/**
 * Query-param parsing for `GET /api/search` — the owner-facing HTTP twin of
 * the `search_nodes` / `search_chunks` MCP tools (mobile companion's search).
 * Pure so it can be unit-tested without the route runtime.
 */

/** Mirrors the `search_nodes` tool's `type` enum — the API's contract. */
export const SEARCH_NODE_TYPES = [
  'branch',
  'email',
  'email_thread',
  'file',
  'note',
  'page',
  'sermon',
  'contact',
  'task',
  'event',
  'printer_project',
  'telegram_message',
  'documentation',
  'journal',
] as const;

export type SearchNodeType = (typeof SEARCH_NODE_TYPES)[number];

export type SearchApiQuery = {
  q: string;
  mode: 'nodes' | 'chunks';
  type?: SearchNodeType;
  branch?: string;
  tags?: string[];
  limit: number;
};

const MAX_Q = 500;
const MAX_TAGS = 10;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// `branch` is cast to ::ltree server-side; reject anything that would make
// the cast throw instead of surfacing a 500.
const LTREE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;

export function parseSearchQuery(sp: URLSearchParams): SearchApiQuery | { error: string } {
  const q = (sp.get('q') ?? '').trim();
  if (!q) return { error: 'q required' };
  if (q.length > MAX_Q) return { error: `q too long (max ${MAX_Q})` };

  const modeRaw = sp.get('mode') ?? 'nodes';
  if (modeRaw !== 'nodes' && modeRaw !== 'chunks') {
    return { error: "mode must be 'nodes' or 'chunks'" };
  }

  let type: SearchNodeType | undefined;
  const typeRaw = sp.get('type')?.trim();
  if (typeRaw) {
    if (!(SEARCH_NODE_TYPES as readonly string[]).includes(typeRaw)) {
      return { error: `unknown type '${typeRaw}'` };
    }
    type = typeRaw as SearchNodeType;
  }

  let branch: string | undefined;
  const branchRaw = sp.get('branch')?.trim();
  if (branchRaw) {
    if (!LTREE_RE.test(branchRaw)) return { error: 'invalid branch' };
    branch = branchRaw;
  }

  let tags: string[] | undefined;
  const tagsRaw = sp.get('tags')?.trim();
  if (tagsRaw) {
    tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS);
    if (tags.length === 0) tags = undefined;
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = sp.get('limit');
  if (limitRaw != null && limitRaw !== '') {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) return { error: 'invalid limit' };
    limit = Math.min(n, MAX_LIMIT);
  }

  return { q, mode: modeRaw, type, branch, tags, limit };
}

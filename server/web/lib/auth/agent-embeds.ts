/**
 * An embed by id is a share (docs/agent-ui.md, "The brain refuses, the
 * window holds"): a note's `media:` / `draw:` / `present:` reference, a page
 * doc's image, file embed, embedded drawing or child page card, a drawing's
 * file map, each adds a node_embeds edge (migration 0208), and the embedded
 * item is then read through the host's share. So an agent-driven write that
 * adds an embed the host does not hold yet, to a host others can read
 * (othersCanRead, the rule an API key's page write meets in
 * app/api/v1/pages/[id]/route.ts), is refused `sharing_field`. A write that
 * keeps the host's embeds as they are passes. A create, whose host is not
 * there yet to ask, is refused when it carries any embed: it lands where
 * the person is, which may be read by others.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { othersCanRead } from '@mantle/tools';
import { referencedEmbedIds } from '@mantle/content';

/** What a route's JSON body embeds, by the route (`METHOD pattern`), and
 *  whether it writes an existing host (its `:id`) or makes a new one. */
type EmbedSource = { host: 'id' | 'new'; ids: (body: Record<string, unknown>) => string[] };

/** Every `media:`, `draw:` and `present:` id in a note's markdown: the
 *  database records an edge wherever the note shows one (0208,
 *  mantle_note_embed_refs), a superset of what the markdown parser lifts. */
function noteIds(markdown: unknown): string[] {
  if (typeof markdown !== 'string') return [];
  const out = new Set<string>();
  for (const m of markdown.matchAll(
    /(?:media|draw|present):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
  )) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

const docIds = (doc: unknown): string[] =>
  doc && typeof doc === 'object' ? referencedEmbedIds(doc).map((id) => id.toLowerCase()) : [];

const fileMapIds = (refs: unknown): string[] =>
  refs && typeof refs === 'object' && !Array.isArray(refs)
    ? [
        ...new Set(
          Object.values(refs as Record<string, unknown>)
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .map((v) => v.toLowerCase()),
        ),
      ]
    : [];

/** The routes an agent may write through (agent-call.allowed.ts) that can
 *  carry an embed. A table holds no embed edge (it is no embedding kind),
 *  nor does the journal (refused anyway): not here. A draft's embeds become
 *  the host's on its commit, which is refused for an agent; they are held
 *  to the host's own embeds all the same. */
export const EMBED_SOURCES: Readonly<Record<string, EmbedSource>> = {
  'PATCH /api/notes/:id': { host: 'id', ids: (b) => noteIds(b.content) },
  'POST /api/notes': { host: 'new', ids: (b) => noteIds(b.content) },
  'POST /api/v1/notes': { host: 'new', ids: (b) => noteIds(b.content) },
  'PATCH /api/pages/:id': { host: 'id', ids: (b) => docIds(b.doc) },
  'PATCH /api/v1/pages/:id': { host: 'id', ids: (b) => docIds(b.doc) },
  'PUT /api/pages/:id/draft': { host: 'id', ids: (b) => docIds(b.doc) },
  'POST /api/pages': { host: 'new', ids: (b) => docIds(b.doc) },
  'POST /api/v1/pages': { host: 'new', ids: (b) => docIds(b.doc) },
  'PUT /api/draws/:id/draft': {
    host: 'id',
    ids: (b) => fileMapIds(b.file_refs ?? b.fileRefs),
  },
  'POST /api/draws': { host: 'new', ids: (b) => fileMapIds(b.file_refs ?? b.fileRefs) },
};

/** Whether a host gains an embed others would read through it: asked of
 *  the database, injectable for tests. */
export type EmbedShareCheck = (hostId: string | null, ids: readonly string[]) => Promise<boolean>;

/** The host's own embeds now (direct edges), by the definer the Grant
 *  Access panel reads them with (0291 mantle_item_embeds). */
async function embedsOf(hostId: string): Promise<Set<string>> {
  const rows = (await db.execute(
    sql`select e.to_id::text as id from mantle_item_embeds(${hostId}::uuid) e where not e.hop`,
  )) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** The brain the request serves. */
export async function brainId(): Promise<string | null> {
  const [row] = (await db.execute(sql`select mantle_brain_id()::text as id`)) as unknown as {
    id: string | null;
  }[];
  return row?.id ?? null;
}

/** The default check: a new host with any embed; an existing one that gains
 *  an embed it does not hold, when others can read it. */
export const embedSharesItem: EmbedShareCheck = async (hostId, ids) => {
  if (ids.length === 0) return false;
  if (hostId === null) return true;
  const held = await embedsOf(hostId);
  if (ids.every((id) => held.has(id))) return false;
  const owner = await brainId();
  // No brain to ask: refused, never let through.
  return owner === null ? true : othersCanRead(owner, hostId);
};

/** The `:id` of `pattern` in `pathname`, or null. */
export function pathParam(pattern: string, pathname: string, name = 'id'): string | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const at = want.indexOf(`:${name}`);
  if (at < 0) return null;
  try {
    return decodeURIComponent(got[at]!);
  } catch {
    return null;
  }
}

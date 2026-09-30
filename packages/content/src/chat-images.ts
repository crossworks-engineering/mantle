/**
 * Pictures in a member's or a client's own chat thread (client logins C6).
 * A reply is markdown, and the chat draws every markdown image. The agent
 * writes a picture the way the owner's assistant does, `![alt](media:<id>)`
 * or a path to the owner's file route (`/api/files/files/<id>?raw=1`), and
 * both point a member or a client at a route that is not theirs. So the
 * thread is sent with every image reference rewritten for its reader:
 *
 *  - an image of an item the reader may read (a file or a drawing of this
 *    brain at their level: team for a member, client for a client) points
 *    at the reader's own route (`/api/member/files/<id>`,
 *    `/api/client/draws/<id>/svg`, and so on);
 *  - every other image is left out: an item above their level, an id that
 *    is not an item, an external or `data:` image, anything this does not
 *    recognise. A client is never pointed at an admin route, and never made
 *    to load a picture from another site.
 *
 * What an image names is embed-refs.ts's reading (the one the redactors
 * use): the app's schemes (`media:`, `draw:`), any relative path with ONE
 * id, and an absolute URL into this brain read as its path. A
 * reference-style image (`![alt][ref]` with its `[ref]: target` line) is
 * read as the inline image it stands for. Fail closed: any `![` still left
 * after that (a form the pass does not know, such as brackets inside the alt
 * text) is escaped so it cannot draw a picture, and so is a raw `<img`.
 *
 * Pure except `chatImagesFor`, which asks the database, once per thread page,
 * at the reader's level.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, nodes, withViewer } from '@mantle/db';
import { clientOwnUrl } from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { pageRefs, type OwnUrl } from './embed-refs';

/** Whose thread: a member's (team level) or a client's (client level). */
export type ChatImageReader = 'team' | 'client';

/** The kinds of item a chat picture may show, by the reader's route. */
export type ChatImageKind = 'file' | 'draw';

/** The reader's own route for a picture of an item they may read. */
export function chatImageSrc(reader: ChatImageReader, kind: ChatImageKind, id: string): string {
  const base = reader === 'client' ? '/api/client' : '/api/member';
  return kind === 'file' ? `${base}/files/${id}` : `${base}/draws/${id}/svg`;
}

/** `![alt](target "title")`: the inline form. The alt holds no unescaped
 *  `]`; anything else is left to the fail-closed pass. */
const MD_IMAGE =
  /!\[((?:\\.|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
/** `![alt][ref]`, `![alt][]` and `![ref]` (the reference forms). */
const MD_REF_IMAGE = /!\[((?:\\.|[^\\\]])*)\](?:\[((?:\\.|[^\\\]])*)\])?(?![([])/g;
/** `[ref]: target`, a reference definition at the start of a line. */
const MD_DEFINITION = /^ {0,3}\[((?:\\.|[^\\\]])+)\]:[ \t]*(<[^>\n]*>|\S+)/gm;

const normLabel = (l: string) => l.trim().replace(/\s+/g, ' ').toLowerCase();
const unwrap = (t: string) => (t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t);

/** The text with each reference-style image written as the inline image it
 *  stands for (a reference with no definition is no image: left as it is). */
function inlineRefImages(text: string): string {
  const defs = new Map<string, string>();
  for (const m of text.matchAll(MD_DEFINITION)) {
    const key = normLabel(m[1] ?? '');
    if (!defs.has(key)) defs.set(key, unwrap(m[2] ?? ''));
  }
  if (!defs.size) return text;
  return text.replace(MD_REF_IMAGE, (whole, alt: string, ref: string | undefined) => {
    const target = defs.get(normLabel(ref || alt));
    return target === undefined ? whole : `![${alt}](<${target.replace(/[<>\n]/g, '')}>)`;
  });
}

/** The one item an image target names, or null (no item, several, or a
 *  target the reading refuses). */
function imageId(target: string, ownUrl: OwnUrl): string | null {
  const refs = pageRefs({ type: 'image', attrs: { src: unwrap(target) } }, ownUrl);
  return refs.ids.length === 1 && refs.refused.length === 0 ? refs.ids[0]! : null;
}

/** Every item id the images in these texts name (for the one query). */
export function chatImageIds(
  texts: Iterable<string>,
  ownUrl: OwnUrl = clientOwnUrl(clientRedactOrigins()),
): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text || !text.includes('![')) continue;
    for (const m of inlineRefImages(text).matchAll(MD_IMAGE)) {
      const id = imageId(m[2] ?? '', ownUrl);
      if (id) out.add(id);
    }
  }
  return [...out];
}

/**
 * One chat text as its reader receives it: see the top of this file.
 * `readable` = the lower-case ids of the files and drawings the reader may
 * read, with their kind (`chatImagesFor`).
 */
export function rewriteChatImages(
  text: string,
  readable: ReadonlyMap<string, ChatImageKind>,
  reader: ChatImageReader,
  ownUrl: OwnUrl = clientOwnUrl(clientRedactOrigins()),
): string {
  if (!text || (!text.includes('![') && !/<img/i.test(text))) return text;
  const kept: string[] = [];
  const pass = inlineRefImages(text).replace(MD_IMAGE, (_whole, alt: string, target: string) => {
    const id = imageId(target, ownUrl);
    const kind = id ? readable.get(id) : undefined;
    if (!id || !kind) return '';
    // Held aside while the fail-closed pass runs (a stored text never holds
    // a NUL, strip-nul.ts).
    kept.push(`![${alt}](${chatImageSrc(reader, kind, id)})`);
    return `\u0000${kept.length - 1}\u0000`;
  });
  return (
    pass
      .replace(/!\[/g, '!\\[')
      .replace(/<img/gi, '&lt;img')
      // eslint-disable-next-line no-control-regex -- the placeholder above
      .replace(/\u0000(\d+)\u0000/g, (_w, i: string) => kept[Number(i)] ?? '')
  );
}

/**
 * The files and drawings among `ids` the reader may read, with their kind:
 * this brain's items at the reader's level, read at that level (row security
 * decides; for a client the level is in the query as well). Keys lower-case.
 * Called on the admin pool (the chat routes), never inside a viewer scope.
 */
export async function chatImagesFor(
  anchorId: string,
  reader: ChatImageReader,
  ids: readonly string[],
): Promise<Map<string, ChatImageKind>> {
  const out = new Map<string, ChatImageKind>();
  if (!ids.length) return out;
  const rows = await withViewer(reader, () =>
    db
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, anchorId),
          inArray(nodes.id, [...ids]),
          inArray(nodes.type, ['file', 'draw']),
          reader === 'client' ? eq(nodes.audience, 'client') : undefined,
        ),
      ),
  );
  for (const r of rows) out.set(r.id.toLowerCase(), r.type as ChatImageKind);
  return out;
}

/** A page of chat texts as their reader receives them (one query). */
export async function chatTextsForReader(
  anchorId: string,
  reader: ChatImageReader,
  texts: readonly string[],
): Promise<string[]> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const ids = chatImageIds(texts, ownUrl);
  const readable = ids.length
    ? await chatImagesFor(anchorId, reader, ids)
    : new Map<string, ChatImageKind>();
  return texts.map((t) => rewriteChatImages(t, readable, reader, ownUrl));
}

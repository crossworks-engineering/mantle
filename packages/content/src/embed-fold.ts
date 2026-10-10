/**
 * Always fold (workspaces plan 5.3, phase W2): the text a page, note or
 * drawing indexes holds the item's OWN words, and a plain marker where it
 * embeds another item. The embedded item is indexed as its own item and found
 * through its own grants (today: its own level), so a reader who may read the
 * page but not the embed finds none of the embed's words in the page's
 * doc_text, scene_text or chunks. At every level, not only client and public.
 *
 * Pure, no database.
 */
import { DRAW_HREF, MEDIA_HREF } from '@mantle/content-core/markdown-refs';

export const EMBED_MARKER_FILE = '[embedded file]';
export const EMBED_MARKER_DRAWING = '[embedded drawing]';
export const EMBED_MARKER_PAGE = '[embedded page]';

/** A markdown image or link (`![alt](href)`, `[label](href)`). */
const MD_REF = /(!?)\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)\)/g;

/**
 * A note's markdown as it is indexed: an embedded file or drawing
 * (`![alt](media:<id>)`, `[label](media:<id>)`, `![alt](draw:<id>)`) becomes
 * its marker, so neither its caption nor its name lands in the note's chunks.
 * Every other link, and the note's own text, is unchanged.
 */
export function foldNoteEmbeds(markdown: string): string {
  if (!markdown) return markdown;
  return markdown.replace(MD_REF, (whole, _bang: string, href: string) => {
    if (MEDIA_HREF.test(href)) return EMBED_MARKER_FILE;
    if (DRAW_HREF.test(href)) return EMBED_MARKER_DRAWING;
    return whole;
  });
}

/** The marker lines a drawing's indexed text carries for the images it
 *  places: one per distinct embedded file. */
export function drawEmbedMarkers(fileIds: readonly string[]): string {
  return [...new Set(fileIds)].map(() => EMBED_MARKER_FILE).join('\n');
}

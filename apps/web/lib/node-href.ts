/**
 * In-app route for a node, by its type. Used by the backlinks panel and the
 * @-mention chip click-through to navigate to a referenced page/note. Returns
 * null for types that have no dedicated detail route (the caller renders an
 * inert label instead of a dead link).
 */
export function nodeHref(kind: string | null | undefined, id: string): string | null {
  switch (kind) {
    case 'page':
      return `/pages/${id}`;
    case 'note':
      return `/notes/${id}`;
    default:
      return null;
  }
}

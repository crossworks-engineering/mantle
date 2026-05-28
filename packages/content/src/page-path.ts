/**
 * ltree path helpers for the pages tree (Phase 4a sub-pages). Pure + leaf
 * (no DB import) so the rules — ltree-label safety, nested path composition —
 * are unit-testable without a database. `createPage` in pages.ts is the only
 * caller; this exists so the invariant ("a child's path is a valid ltree
 * extension of its parent's") can be locked down in a test.
 */

/**
 * Postgres-ltree-safe label from a node UUID. ltree labels accept only
 * `[A-Za-z0-9_]`, so the UUID's hyphens become underscores. Using the child's
 * own id keeps sibling pages from ever colliding on `path`.
 */
export function ltreeLabelFromId(id: string): string {
  return id.replace(/-/g, '_');
}

/**
 * Child page ltree path = the parent's path plus the child's id-label. Keeps
 * the child a descendant of the `pages` root (so existing `<@ 'pages'` scoping
 * still matches) and nests deeper for grandchildren.
 */
export function childPagePath(parentPath: string, childId: string): string {
  return `${parentPath}.${ltreeLabelFromId(childId)}`;
}

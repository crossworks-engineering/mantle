/**
 * Pages surface. A page is a `nodes` row with type='page' plus a `pages`
 * sidecar row holding the TipTap / ProseMirror document:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji / icon
 *   nodes.data.summary    extractor-written summary
 *   nodes.data.visibility 'private' | 'public' (read-only sharing, phase 5)
 *   pages.doc             ProseMirror JSON (source of truth)
 *   pages.doc_text        derived plaintext (the extractor + FTS read this)
 *
 * All under the `pages` ltree root, lazy-created on first write. `page` is in
 * the extractor's DEFAULT_EXTRACT_TYPES, so summary + embedding land
 * automatically on the next pg_notify('node_ingested'); `readNodeBodyRaw`
 * reads `doc_text` from the sidecar.
 */

/**
 * Split out of the 1244-line pages.ts on 2026-09-02 (audit, tier 3) along its
 * five natural seams: shared spine, read, tree, draft/commit, structure, and
 * embedded-asset text. The dependency order is acyclic and one-way —
 * shared <- embed <- read <- tree <- draft <- structure — so no module here
 * imports this barrel.
 *
 * The export list below is CURATED, not `export *`, and is UNCHANGED from the
 * single file it replaces: `@mantle/content/pages` is a public sub-path, so a
 * helper that had to become cross-module (rowOf, detailOf, dedupeTags,
 * embeddedAssetText) must NOT leak into it as API nobody chose to promise.
 * `pages-exports.test.ts` pins the list.
 */

export type { PageSort, Backlink, PageVisibility, PageWidth, PageRow } from '@mantle/client-types';

export { PAGES_ROOT_LABEL, EMPTY_DOC, type PageDetail } from './shared';

export {
  listPages,
  countPages,
  listPageTags,
  getPage,
  listChildPages,
  countPageDescendants,
  listBacklinks,
} from './read';

export {
  createPage,
  movePage,
  deletePage,
  ParentPageNotFoundError,
  PageCycleError,
  type CreatePageInput,
} from './tree';

export {
  withPageLock,
  evaluateDraftRev,
  updatePage,
  saveDraft,
  discardDraft,
  commitPage,
  commitPageDraft,
  type LockedPageRow,
  type UpdatePageInput,
  type SaveDraftResult,
  type CommitPageResult,
  type CommitPageDraftResult,
} from './draft';

export {
  splitPage,
  extractSectionToChild,
  addPageMention,
  NoSplitHeadingsError,
  SectionNotFoundError,
  MentionTargetNotFoundError,
  MentionAnchorNotFoundError,
  type SplitPageResult,
  type ExtractSectionResult,
  type AddMentionResult,
} from './structure';

export { EMBED_TEXT_PER_FILE, EMBED_TEXT_TOTAL, foldEmbeddedText } from './embed';

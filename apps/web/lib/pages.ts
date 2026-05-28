/** Re-export from the shared workspace package. See @mantle/content. */
export {
  PAGES_ROOT_LABEL,
  EMPTY_DOC,
  listPages,
  countPages,
  listPageTags,
  listChildPages,
  getPage,
  createPage,
  ParentPageNotFoundError,
  updatePage,
  saveDraft,
  discardDraft,
  commitPage,
  deletePage,
  type PageRow,
  type PageDetail,
  type PageVisibility,
  type PageWidth,
  type CreatePageInput,
  type UpdatePageInput,
} from '@mantle/content/pages';

// docToText lives in its own module (it's reused beyond pages); surface it
// here so route handlers have a single import site for the pages surface.
export { docToText } from '@mantle/content';

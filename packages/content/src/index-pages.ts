/**
 * @mantle/content · pages
 *
 * Pages — the TipTap document surface: CRUD, blocks, mentions, embedded assets and the docx/email renderers.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  countDerivedFromFile,
  describeDerivedCounts,
  reapDerivedFromFile,
  deleteFileWithDerived,
  isPerDocumentExtractedImagesPath,
  type DerivedCounts,
  type ReapResult,
  type CascadeDeleteResult,
} from './derived';

export {
  PAGES_ROOT_LABEL,
  EMPTY_DOC,
  listPages,
  countPages,
  listPageTags,
  getPage,
  createPage,
  updatePage,
  movePage,
  countPageDescendants,
  PageCycleError,
  addPageMention,
  MentionTargetNotFoundError,
  MentionAnchorNotFoundError,
  saveDraft,
  discardDraft,
  commitPage,
  commitPageDraft,
  deletePage,
  splitPage,
  NoSplitHeadingsError,
  extractSectionToChild,
  SectionNotFoundError,
  type PageRow,
  type PageDetail,
  type PageVisibility,
  type PageWidth,
  type CreatePageInput,
  type UpdatePageInput,
  type SplitPageResult,
  type ExtractSectionResult,
  type AddMentionResult,
  type CommitPageResult,
  type CommitPageDraftResult,
} from './pages';
export {
  splitDocByHeading,
  extractSection,
  headingText,
  type SplitLevel,
  type SplitResult,
  type ExtractResult,
} from '@mantle/content-core/page-split';
export {
  computeDiffOverlay,
  type DiffOverlay,
  type RemovedGhost,
} from '@mantle/content-core/page-diff';

export { docToText } from './doc-to-text';

export { markdownToDoc } from '@mantle/content-core/markdown';
export { docToMarkdown } from '@mantle/content-core/doc-to-markdown';

export {
  ensureBlockIds,
  repairTableRows,
  allBlocksHaveIds,
  BLOCK_NODE_TYPES,
} from '@mantle/content-core/block-ids';

export {
  listBlocks,
  type BlockListEntry,
  type ListBlocksOptions,
} from '@mantle/content-core/block-list';

export {
  findBlock,
  replaceBlock,
  insertAfterBlock,
  insertBeforeBlock,
  appendBlocks,
  wrapBlocks,
  deleteBlock,
  type FindResult,
  type PMBlockNode,
  type WrapContainer,
} from './block-edit';

export { diffBlocks, type BlockDiff, type BlockChange } from '@mantle/content-core/block-diff';

export { referencedFileIds, referencedDrawIds } from './doc-assets';

export {
  supersedeNode,
  unsupersedeNode,
  salienceForSupersedeReason,
  wouldCreateSupersedeCycle,
  SUPERSEDE_CHAIN_CAP,
  type SupersedeReason,
  type SupersedeNodeInput,
} from './supersede';

export {
  renderPageEmail,
  cidForPageImage,
  type RenderPageEmailOptions,
  type RenderPageEmailResult,
} from './render-page-email';

export { renderDocx, type RenderDocxOptions, type LoadedImage } from './render-docx';
export { fileFamilyKey } from './file-family';

export {
  mentionRefs,
  buildMentionParagraph,
  type MentionRefs,
  type MentionRef,
} from './mention-refs';

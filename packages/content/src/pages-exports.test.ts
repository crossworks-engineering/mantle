import { describe, expect, it } from 'vitest';
import * as pagesApi from './pages';

/**
 * `@mantle/content/pages` is a PUBLIC package sub-path (see package.json
 * `exports`), so its export list is a promise, not an implementation detail.
 *
 * The 2026-09-02 split of the 1244-line pages.ts into pages/{shared,read,tree,
 * draft,structure,embed}.ts forced four helpers that used to be module-private
 * to become cross-module exports: `rowOf`, `detailOf`, `dedupeTags` and
 * `embeddedAssetText`. If pages/index.ts is ever relaxed from its curated
 * re-export list to `export *`, all four silently become public API — and so
 * does every future internal helper. This pins the list so that widening is a
 * failing test rather than an accident.
 *
 * Runtime values only: `import *` cannot see type-only exports, so the eight
 * exported types are pinned by the compiler instead (server/web/lib/pages.ts
 * and index-pages.ts both name them, so dropping one fails typecheck).
 */
const PUBLIC_VALUE_EXPORTS = [
  'EMBED_TEXT_PER_FILE',
  'EMBED_TEXT_TOTAL',
  'EMPTY_DOC',
  'MentionAnchorNotFoundError',
  'MentionTargetNotFoundError',
  'NoSplitHeadingsError',
  'PAGES_ROOT_LABEL',
  'PageCycleError',
  'ParentPageNotFoundError',
  'SectionNotFoundError',
  'addPageMention',
  'commitPage',
  'commitPageDraft',
  'countPageDescendants',
  'countPages',
  'createPage',
  'deletePage',
  'discardDraft',
  'evaluateDraftRev',
  'extractSectionToChild',
  'foldEmbeddedText',
  'getPage',
  'listBacklinks',
  'listChildPages',
  'listPageTags',
  'listPages',
  'movePage',
  'saveDraft',
  'splitPage',
  'updatePage',
  'withPageLock',
];

/** Helpers the split made cross-module. None of them is API. */
const MUST_STAY_INTERNAL = ['rowOf', 'detailOf', 'dedupeTags', 'embeddedAssetText'];

describe('@mantle/content/pages public surface', () => {
  it('exports exactly the pinned list', () => {
    expect(Object.keys(pagesApi).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it('does not leak the split helpers', () => {
    for (const name of MUST_STAY_INTERNAL) {
      expect(Object.keys(pagesApi)).not.toContain(name);
    }
  });
});

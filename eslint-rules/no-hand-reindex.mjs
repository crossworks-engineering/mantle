/**
 * no-hand-reindex (arch plan A10 #7): a write re-indexes its item through
 * ONE call, markContentChanged (packages/db/src/content-changed.ts), which
 * reads what each changed field feeds from the kind registry (`indexed`,
 * packages/client-types/src/kinds.ts). A hand re-index in product code is an
 * error outside the files REINDEX_ALLOW names with their reason:
 *
 *  - a notifyNodeIngested( call, or a raw pg_notify('node_ingested', ...);
 *  - an `embedding: null` (a hand vector reset);
 *  - a hand summary clear: `delete <x>.summary` or `- 'summary'` on jsonb.
 *
 * Why: before A10 #7, 18 files did it by hand (23 notify calls, 24 vector
 * resets, 11 files dropping the summary keys) and they disagreed: a rename
 * re-indexed a task or an event, never a note, a journal, a formula, a page
 * or a table, so search and recall kept the old titles.
 *
 * The same counts are the scoreboard's reindexNotifyCalls,
 * reindexEmbeddingResets and reindexSummaryClears (each pinned at 0), and
 * eslint-rules/arch-lints.test.ts holds the allowed files to exactly the ones
 * that still hold such a line.
 */
import { isCounted, repoPathOf, stripComments } from './arch-counts.mjs';

/** The files that may hold a hand re-index line, each with why. */
export const REINDEX_ALLOW = Object.freeze({
  'packages/db/src/content-changed.ts':
    'the gateway itself: markContentChanged resets and announces, resignalNode re-signals',
  'packages/db/src/notify.ts': "notifyNodeIngested's own definition, which only the gateway calls",
  'packages/db/src/access-matrix.ts':
    'the edit check rule that an edit may only clear the vector (`safe: { embedding: null }`), not a reset',
  'packages/content/src/recall-native.ts':
    "a Recall card's prompt vector (recall_nodes), refilled by recall_match; not an item's index",
  'packages/embeddings/src/reembed.ts':
    'the Recall prompt vectors (recall_nodes) a model switch clears; not an item index',
  'server/web/scripts/extract-backfill.ts':
    'a hand-run operator backfill that re-fires node_ingested for unextracted nodes (dry run by default)',
  'server/web/scripts/relations-backfill.ts':
    'a hand-run operator backfill that drops data.summary to force a full re-extract through the relations pass',
});

const NOTIFY_CALL = /(?<!function\s)\bnotifyNodeIngested\s*\(/g;
const RAW_NOTIFY = /pg_notify\(\s*'node_ingested'\s*,/g;
const EMBEDDING_RESET = /\bembedding:\s*null\b/g;
const SUMMARY_CLEAR = /\bdelete\s+[\w$.]+\.summary\b(?!_)|-\s*'summary'/g;

const count = (re, code) => (code.match(re) ?? []).length;

/** The hand re-index lines of `text`, by sort (comments never count). */
export function handReindex(text) {
  const code = stripComments(text);
  return {
    notify: count(NOTIFY_CALL, code) + count(RAW_NOTIFY, code),
    embedding: count(EMBEDDING_RESET, code),
    summary: count(SUMMARY_CLEAR, code),
  };
}

export const noHandReindex = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A write re-indexes through markContentChanged, never by hand (arch plan A10 #7).',
    },
    messages: {
      hand: 'A hand re-index ({{what}}): call markContentChanged(tx, node, changedFields) after the write (@mantle/db), and name what the field feeds in the kind registry (`indexed`, packages/client-types/src/kinds.ts). A re-signal of an unchanged item is resignalNode. A file that must stay is named with its reason in eslint-rules/no-hand-reindex.mjs REINDEX_ALLOW.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path) || Object.hasOwn(REINDEX_ALLOW, path)) return {};
    return {
      Program(node) {
        const n = handReindex(context.sourceCode.getText());
        const what = [
          n.notify ? `${n.notify} notify` : '',
          n.embedding ? `${n.embedding} vector reset` : '',
          n.summary ? `${n.summary} summary clear` : '',
        ].filter(Boolean);
        if (what.length)
          context.report({ node, messageId: 'hand', data: { what: what.join(', ') } });
      },
    };
  },
};

export default {
  rules: { 'no-hand-reindex': noHandReindex },
};

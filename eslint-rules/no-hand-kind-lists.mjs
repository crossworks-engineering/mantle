/**
 * no-hand-kind-lists: a list of kinds is a filter over
 * the kind registry (packages/client-types/src/kinds.ts, the derived lists
 * in kind-lists.ts), never a literal. A literal list of 3 or more node_type
 * values in product code is an error, outside the files KIND_LIST_ALLOW
 * names with their reason (eslint-rules/arch-counts.mjs). A list is read
 * from the syntax tree (eslint-rules/name-lists.mjs): an array wherever it
 * is written (a Set's, a z.enum's, after `of`, `&&` or `export default`, in
 * a spread), a union type, an object's keys (not a dispatch table of
 * functions), a comparison chain, a switch's shared cases and a SQL `in`
 * list in a string or template. Each list is reported where it is written.
 *
 * Why: about ten such lists bypassed the registry, and three disagreed with
 * it (the integrity view could not see three kinds the extractor reads). A
 * new kind was only half supported until each list was found by hand.
 *
 * The same count is the scoreboard's handKindLists (pinned at 0) and
 * eslint-rules/arch-lints.test.ts holds the allowed files to exactly the
 * ones that still hold a list. The node types are read from the schema enum
 * (packages/db/src/schema/nodes.ts) of the repo this rule file is in, found
 * from the rule file and not from ESLint's working directory (run from
 * another directory it would find no enum); no enum there is an error,
 * never a silent pass.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIND_LIST_ALLOW,
  handKindListSites,
  isCounted,
  nodeTypes,
  repoPathOf,
} from './arch-counts.mjs';

/** The repo this rule file is in. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The node types, read once (nodeTypes throws when there are none). */
let types = null;
function typesOf() {
  types ??= nodeTypes(ROOT);
  return types;
}

export const noHandKindLists = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A list of kinds is a filter over the kind registry, not a literal (arch plan A10 #12).',
    },
    messages: {
      list: 'A literal list of {{n}} kinds ({{form}}): add a field to KindSpec (packages/client-types/src/kinds.ts) and derive the list in kind-lists.ts. A list that must stay literal is named with its reason in eslint-rules/arch-counts.mjs KIND_LIST_ALLOW.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path) || Object.hasOwn(KIND_LIST_ALLOW, path)) return {};
    const known = typesOf();
    return {
      Program() {
        for (const site of handKindListSites(context.sourceCode.getText(), known, path)) {
          context.report({
            loc: { start: site.start, end: site.end },
            messageId: 'list',
            data: { n: String(site.n), form: site.form },
          });
        }
      },
    };
  },
};

export default {
  rules: { 'no-hand-kind-lists': noHandKindLists },
};

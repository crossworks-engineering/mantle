/**
 * no-hand-kind-lists (arch plan A10 #12): a list of kinds is a filter over
 * the kind registry (packages/client-types/src/kinds.ts, the derived lists
 * in kind-lists.ts), never a literal. A literal list of 3 or more node_type
 * values (an array, a Set's, a z.enum's, an inline `[...].includes(`) in
 * product code is an error, outside the files KIND_LIST_ALLOW names with
 * their reason (eslint-rules/arch-counts.mjs).
 *
 * Why: about ten such lists bypassed the registry, and three disagreed with
 * it (the integrity view could not see three kinds the extractor reads). A
 * new kind was only half supported until each list was found by hand.
 *
 * The same count is the scoreboard's handKindLists (pinned at 0) and
 * eslint-rules/arch-lints.test.ts holds the allowed files to exactly the
 * ones that still hold a list. The node types are read from the schema enum
 * (packages/db/src/schema/nodes.ts) of the repo ESLint runs in.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND_LIST_ALLOW,
  handKindLists,
  isCounted,
  nodeTypes,
  repoPathOf,
} from './arch-counts.mjs';

/** The node types, by repo root (one read per lint run). */
const typesByRoot = new Map();

function typesOf(root) {
  if (!typesByRoot.has(root)) {
    const ok = existsSync(join(root, 'packages/db/src/schema/nodes.ts'));
    typesByRoot.set(root, ok ? nodeTypes(root) : new Set());
  }
  return typesByRoot.get(root);
}

export const noHandKindLists = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A list of kinds is a filter over the kind registry, not a literal (arch plan A10 #12).',
    },
    messages: {
      list: 'A literal list of {{n}} kinds: add a field to KindSpec (packages/client-types/src/kinds.ts) and derive the list in kind-lists.ts. A list that must stay literal is named with its reason in eslint-rules/arch-counts.mjs KIND_LIST_ALLOW.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path) || Object.hasOwn(KIND_LIST_ALLOW, path)) return {};
    const types = typesOf(context.cwd ?? process.cwd());
    if (!types.size) return {};
    return {
      Program(node) {
        for (const n of handKindLists(context.sourceCode.getText(), types)) {
          context.report({ node, messageId: 'list', data: { n: String(n) } });
        }
      },
    };
  },
};

export default {
  rules: { 'no-hand-kind-lists': noHandKindLists },
};

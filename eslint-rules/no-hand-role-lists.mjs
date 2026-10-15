/**
 * no-hand-role-lists (arch plan A10 #13): a role, area or actor name list is
 * read from its source (ROLE_NAME_SOURCES in eslint-rules/arch-counts.mjs:
 * LOGIN_ROLES, HISTORY_ACTORS and RECALL_ACTOR_KINDS in
 * packages/client-types/src/role-names.ts; WORKSPACE_AREAS, ACCESS_LEVELS
 * and ACCESS_KEY_AREAS in its dto modules), never written again by hand. A
 * literal list (an array, a Set's, a z.enum's), a string union or a
 * comparison chain (`r === 'admin' || r === 'member'`) whose entries are
 * all names of one concept is an error in product code outside that
 * concept's source file.
 *
 * Why: the login roles were written by hand about thirty times, the Admin
 * areas four, the history actors three. These lists gate access: a role
 * added to one copy and missed in another lets a check refuse (or admit)
 * what the rest do not.
 *
 * The same count is the scoreboard's handRoleLists (pinned at 0). The names
 * are read from the source files of the repo ESLint runs in.
 */
import { handRoleLists, isCounted, repoPathOf, roleNameSets } from './arch-counts.mjs';

/** The name sets, by repo root (one read per lint run). */
const setsByRoot = new Map();

function setsOf(root) {
  if (!setsByRoot.has(root)) setsByRoot.set(root, roleNameSets(root));
  return setsByRoot.get(root);
}

export const noHandRoleLists = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A role, area or actor name list is read from its source, not written by hand (arch plan A10 #13).',
    },
    messages: {
      list: 'A hand copy of {{n}} {{concept}} names: import the list or its type from its source (eslint-rules/arch-counts.mjs ROLE_NAME_SOURCES; docs/actors.md, "Role and area names"). A membership test is isLoginRole / isWorkspaceArea; a zod enum is z.enum(THE_LIST).',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path)) return {};
    const sets = setsOf(context.cwd ?? process.cwd());
    if (!Object.keys(sets).length) return {};
    return {
      Program(node) {
        for (const r of handRoleLists(context.sourceCode.getText(), sets, path)) {
          if (r.allowed) continue;
          context.report({ node, messageId: 'list', data: { n: String(r.n), concept: r.concept } });
        }
      },
    };
  },
};

export default {
  rules: { 'no-hand-role-lists': noHandRoleLists },
};

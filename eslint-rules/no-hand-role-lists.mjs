/**
 * no-hand-role-lists (arch plan A10 #13): a role, area or actor name list is
 * read from its source (ROLE_NAME_SOURCES in eslint-rules/arch-counts.mjs:
 * LOGIN_ROLES, HISTORY_ACTORS and RECALL_ACTOR_KINDS in
 * packages/client-types/src/role-names.ts; WORKSPACE_AREAS, ACCESS_LEVELS
 * and ACCESS_KEY_AREAS in its dto modules), never written again by hand. A
 * literal list (an array, a Set's, a z.enum's), a string union, a
 * comparison chain (`r === 'admin' || r === 'member'`, the subject any
 * expression: `a?.role`, `f(x)`), a
 * switch's shared cases or a SQL `in` list in a string or template, whose
 * entries are all names of one concept, is an error in product code outside
 * that concept's source file; so is a list holding every login role and
 * more (`'admin' | 'member' | 'client'`): build it from LoginRole and name
 * the extras. The lists are read from the syntax tree
 * (eslint-rules/name-lists.mjs) and each is reported where it is written.
 *
 * Why: the login roles were written by hand about thirty times, the Admin
 * areas four, the history actors three. These lists gate access: a role
 * added to one copy and missed in another lets a check refuse (or admit)
 * what the rest do not.
 *
 * The same count is the scoreboard's handRoleLists (pinned at 0). The names
 * are read from the source files of the repo this rule file is in, found
 * from the rule file and not from ESLint's working directory (low round,
 * L2); a missing source is an error, never a silent pass.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handRoleLists, isCounted, repoPathOf, roleNameSets } from './arch-counts.mjs';

/** The repo this rule file is in. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The name sets, read once (roleNameSets throws on a missing source). */
let sets = null;
function setsOf() {
  sets ??= roleNameSets(ROOT);
  return sets;
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
      superset:
        "Every {{concept}} name and more, by hand: build it from the source (LoginRole | 'extra') so a new role reaches it (eslint-rules/arch-counts.mjs ROLE_NAME_SOURCES).",
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path)) return {};
    const known = setsOf();
    return {
      Program() {
        for (const r of handRoleLists(context.sourceCode.getText(), known, path)) {
          if (r.allowed) continue;
          context.report({
            loc: { start: r.start, end: r.end },
            messageId: r.superset ? 'superset' : 'list',
            data: { n: String(r.n), concept: r.concept },
          });
        }
      },
    };
  },
};

export default {
  rules: { 'no-hand-role-lists': noHandRoleLists },
};

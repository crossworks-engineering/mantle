/**
 * `systemDb` (from @mantle/db) always uses the admin pool, whatever the
 * viewer. It exists for the infrastructure writes a turn under a limited role
 * still needs: traces, tool-result spills, the approval queue, access logs,
 * the member's own thread. Used for a CONTENT read it would read straight
 * past row level security (member logins Phase 0b, plan section 2b).
 *
 * So only an allowlisted set of infrastructure modules may import it. Adding a
 * file here is a review decision: say in the PR which infrastructure table it
 * writes, and never use it for nodes, chunks, facts, pages, draws, tables or
 * apps.
 */
export const SYSTEM_DB_ALLOWLIST = [
  'packages/db/src/',
  'packages/tracing/src/store.ts',
  'packages/tools/src/tool-results.ts',
  'packages/turn-stream/src/publish.ts',
  'packages/turn-stream/src/replay.ts',
  'packages/embeddings/src/index.ts',
  'packages/content/src/team-messages.ts',
  'packages/content/src/app-access-log.ts',
  'packages/content/src/team-access-log.ts',
  'packages/runtime/src/agent/tool-loop/execute-call.ts',
  'server/web/lib/audit.ts',
  'packages/api-keys/src/index.ts',
];

/** Whether `filename` (any absolute or relative path) may import systemDb. */
export function isAllowlisted(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.tsx?$/.test(f)) return true;
  return SYSTEM_DB_ALLOWLIST.some((p) => f.includes(`/${p}`) || f.startsWith(p));
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Only allowlisted infrastructure modules may import systemDb from @mantle/db.',
    },
    messages: {
      notAllowed:
        'systemDb reads past row level security. Use `db` for content; only the infrastructure modules in eslint-rules/system-db-allowlist.mjs may import systemDb.',
    },
    schema: [],
  },
  create(context) {
    if (isAllowlisted(context.filename)) return {};
    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@mantle/db' && node.source.value !== '@mantle/db/client') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && spec.imported.name === 'systemDb') {
            context.report({ node: spec, messageId: 'notAllowed' });
          }
        }
      },
    };
  },
};

export default { rules: { 'system-db-allowlist': rule } };

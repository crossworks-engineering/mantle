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
  // The contact share trail (0214): written for any visitor, like the above.
  'packages/content/src/share-access-log.ts',
  'packages/content/src/team-access-log.ts',
  // The member chat traces' token sums (audit F09); the ledger itself is
  // written through its definers (0326, login-definer.ts).
  'packages/content/src/member-turn-ledger.ts',
  // The messenger (0335): its own tables (writer system), written in the
  // content module's transactions with the participant rule in each
  // statement; and the names, workspaces and agents it reads for ids a
  // scoped read returned. Never nodes or any content table.
  'packages/content/src/messenger.ts',
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

/**
 * The route each file's systemDb uses take (plan v3.2 S7a, section 2.1
 * point 7): inside a turn or request scope systemDb runs on the narrow
 * system role while MANTLE_NARROW_SYSTEM is on, outside every scope (a
 * worker, a script, boot) on the full one (gateway/handles.ts). 'narrow':
 * the file is reached in a scope, so its statements hold on the narrow role
 * (measured with the switch on, the DB suites: no denial); 'full': only
 * reached outside every scope. Counted in arch-counts.mjs (systemDbUses_narrow,
 * systemDbUses_full); a file with uses and no mark fails arch:check.
 *
 * A mark is a declaration, not a switch: the route is decided at run time
 * by the scope (gateway/handles.ts), never read from this list. A 'full'
 * file reached in a scope still runs narrow; what holds it is the switch-on
 * suite (a denial fails the test), not the mark.
 */
export const SYSTEM_DB_ROUTE = Object.freeze({
  // Last use of a key in a turn, the vault reads of a tool.
  'packages/api-keys/src/index.ts': 'narrow',
  'packages/content/src/app-access-log.ts': 'narrow',
  'packages/content/src/member-turn-ledger.ts': 'narrow',
  // The messenger's writes and lookups, in the login's request or MCP call.
  'packages/content/src/messenger.ts': 'narrow',
  'packages/content/src/share-access-log.ts': 'narrow',
  'packages/content/src/team-access-log.ts': 'narrow',
  'packages/content/src/team-messages.ts': 'narrow',
  // An assistant's and an AI worker's use counters (last_used_at,
  // usage_count), bumped in the turn or request that used them (S4a list).
  'packages/db/src/agents-resolve.ts': 'narrow',
  'packages/db/src/ai-workers-resolve.ts': 'narrow',
  // The audit row of a tool write, written by the gate in the turn.
  'packages/db/src/call-audit.ts': 'narrow',
  // The push worker's count of parked extractions.
  'packages/db/src/extract-parked.ts': 'full',
  // A one-off maintenance script (extract-skip-stamp.ts).
  'packages/db/src/extract-skip-backfill.ts': 'full',
  // The extract worker's gate.
  'packages/db/src/llm-guard.ts': 'full',
  // An Admin user's item detail (GET /api/nodes/:id), a read.
  'packages/db/src/mixed-summaries.ts': 'narrow',
  // The approval queue, decided in the approver's scope.
  'packages/db/src/pending-elevated.ts': 'narrow',
  // The approval queue's park (at the full-route spot pending-park), claim,
  // return and settle, in the asking or deciding scope (S4a list).
  'packages/db/src/pending-calls.ts': 'narrow',
  // The conversation store's turn rows (recordTurn, a turn's outcome, the
  // cancel route's supersede at the full-route spot turn-supersede), in
  // the turn or request that writes them.
  'packages/db/src/conversation-writes.ts': 'narrow',
  // An embed or extract failure, in a turn's embed as in the workers.
  'packages/db/src/provider-alerts.ts': 'narrow',
  // The embedding cache, in a turn's embed as in the workers.
  'packages/embeddings/src/index.ts': 'narrow',
  'packages/tools/src/tool-results.ts': 'narrow',
  'packages/tracing/src/store.ts': 'narrow',
  'packages/turn-stream/src/publish.ts': 'narrow',
  'packages/turn-stream/src/replay.ts': 'narrow',
  'server/web/lib/audit.ts': 'narrow',
});

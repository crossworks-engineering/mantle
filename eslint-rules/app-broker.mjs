/**
 * The app brokers (A10 #9; docs/request-plumbing.md, "App tool broker"):
 * what a running app's calls go through once, never by hand.
 *
 * no-hand-export-sync: an app's database write schedules its linked
 * app-table exports' sync on the one write path
 * (packages/content/src/app-db-write.ts appDbWrite and appDbSeed). A call
 * of scheduleAppTableExportSync anywhere else is an error, outside the
 * files named below with their reason. Before: five writers (the three db
 * brokers, app_data_write and app_db_seed) each called it by hand after
 * the write; a writer that forgot left the app's Tables stale.
 *
 * no-app-broker-logic: an app's tool call is parsed, judged, dispatched and
 * logged in one place (server/web/lib/app-tool-broker.ts
 * runAppToolBroker); a route, and the member's run, is a config of it. In
 * the HTTP tier (server/), a call of a verdict step (appToolVerdict,
 * contactAppToolVerdict, appToolRefusal, appBrokerCaller, appToolScope,
 * appToolLevel) outside that file is an error, and so is a tool-broker
 * route file that reads or parses its body or dispatches. Before: three
 * copies (the owner route, app-runner.ts, the link route).
 *
 * The scoreboard pins both counts at 0 (handExportSyncCalls,
 * appToolBrokerLogicFiles; arch-counts.mjs), and
 * eslint-rules/arch-lints.test.ts holds the named files to the ones that
 * still call.
 */
import { isCounted, repoPathOf, stripComments } from './arch-counts.mjs';

/** The one write path. */
export const EXPORT_SYNC_HOME = 'packages/content/src/app-db-write.ts';

/** The files that schedule the sync by hand, each with why. */
export const EXPORT_SYNC_ALLOW = Object.freeze({
  'packages/content/src/app-table-exports.ts':
    'its own module: the boot step that resumes the syncs a restart left dirty (resumeDirtyAppTableExports) schedules them through the usual debounce; no write',
  'packages/content/src/app-snapshots.ts':
    "a snapshot restore replaces the database FILE (no statement runs through the write path): the restored rows feed the app's exports",
});

/** Calls of scheduleAppTableExportSync in `code` (comments stripped), not
 *  its definition. */
export function exportSyncCalls(code) {
  return (code.match(/(?<!function\s+)\bscheduleAppTableExportSync\s*\(/g) ?? []).length;
}

/** The one app tool broker. */
export const APP_TOOL_BROKER_HOME = 'server/web/lib/app-tool-broker.ts';

const BROKER_STEPS =
  /(?<!function\s+)\b(?:appToolVerdict|contactAppToolVerdict|appToolRefusal|appBrokerCaller|appToolScope|appToolLevel)\s*\(/g;
const ROUTE_LOGIC = /(?<!function\s+)\b(?:dispatchTool|readJson|readBody)\s*\(|\.safeParse\s*\(/g;

/** Whether `path` is an app tool broker route file. */
export function isToolBrokerRoute(path) {
  return /^server\/web\/app\/.*\/tool-broker\/route\.ts$/.test(path);
}

/** The app tool broker logic `code` (comments stripped) holds in `path`:
 *  verdict steps anywhere in server/, and a tool-broker route's own body
 *  read or dispatch. 0 in the one broker. */
export function appToolBrokerLogic(code, path) {
  if (path === APP_TOOL_BROKER_HOME || !path.startsWith('server/')) return 0;
  let n = (code.match(BROKER_STEPS) ?? []).length;
  if (isToolBrokerRoute(path)) n += (code.match(ROUTE_LOGIC) ?? []).length;
  return n;
}

export const noHandExportSync = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "An app's database write schedules its exports' sync on the one write path (A10 #9).",
    },
    messages: {
      call: 'Write through appDbWrite or appDbSeed (@mantle/content/app-db-write): the write path schedules the export sync. A file that must schedule it by hand is named with its reason in eslint-rules/app-broker.mjs EXPORT_SYNC_ALLOW.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path) || path === EXPORT_SYNC_HOME) return {};
    if (Object.hasOwn(EXPORT_SYNC_ALLOW, path)) return {};
    return {
      Program(node) {
        const n = exportSyncCalls(stripComments(context.sourceCode.getText()));
        for (let i = 0; i < n; i += 1) context.report({ node, messageId: 'call' });
      },
    };
  },
};

export const noAppBrokerLogic = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "An app's tool call is parsed, judged and dispatched in the one broker (A10 #9).",
    },
    messages: {
      logic:
        'App tool broker logic outside server/web/lib/app-tool-broker.ts: give runAppToolBroker a config (who runs the app, its body cap, its app lookup) instead.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path)) return {};
    return {
      Program(node) {
        const n = appToolBrokerLogic(stripComments(context.sourceCode.getText()), path);
        if (n) context.report({ node, messageId: 'logic' });
      },
    };
  },
};

export default {
  rules: {
    'no-hand-export-sync': noHandExportSync,
    'no-app-broker-logic': noAppBrokerLogic,
  },
};

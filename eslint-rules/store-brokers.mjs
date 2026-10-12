/**
 * store-brokers (workspaces arch plan v2, sections 6 and 11; A0): only a
 * store's broker writes its disk (A3b). Today many files reach each disk
 * store's write API; each is listed here by store.
 *
 * Pinned-count mode: eslint-rules/arch-lints.test.ts fails when the files
 * that reach a store differ from this list, so a file may only leave it.
 */
/** @type {Record<string, string[]>} files per store (arch-counts.mjs STORES), A0 baseline */
export const STORE_PINS = {
  appdb: [
    'packages/config/src/index.ts',
    'packages/content/src/app-broker.ts',
    'server/web/lib/maintenance/registry.ts',
  ],
  objectstore: [
    'packages/email/src/sync.ts',
    'packages/files/src/ops/files.ts',
    'packages/microsoft/src/drives/store.ts',
    'packages/tools/src/app-build-stage.ts',
    'server/api/src/agent/extract/file-bytes.ts',
    'server/web/app/api/appearance/logo/route.ts',
    'server/web/app/api/apps/[id]/bundle/css/route.ts',
    'server/web/app/api/apps/[id]/bundle/route.ts',
    'server/web/app/api/attachments/[id]/route.ts',
    'server/web/app/api/profile/logo/route.ts',
    'server/web/app/api/profile/photo/route.ts',
    'server/web/app/s/[token]/bundle/css/route.ts',
    'server/web/app/s/[token]/bundle/route.ts',
    'server/web/lib/app-frame.ts',
    'server/web/lib/onboarding-steps.ts',
    'server/web/lib/sanity/checks.ts',
    'server/web/lib/system-health.ts',
  ],
  tabledb: [
    'packages/content/src/app-broker.ts',
    'packages/content/src/app-table-exports.ts',
    'packages/content/src/app-trash.ts',
    'packages/content/src/app-viewer.ts',
    'packages/content/src/member-snapshots.ts',
    'packages/content/src/table-snapshots.ts',
    'packages/content/src/table-storage.ts',
    'packages/content/src/tables/draft.ts',
    'packages/content/src/tables/read.ts',
    'packages/content/src/tables/shared.ts',
    'packages/content/src/tables/workbook.ts',
    'packages/content/src/tables/write.ts',
    'packages/tools/src/builtins-app-data.ts',
    'packages/tools/src/tables/common.ts',
    'packages/tools/src/tables/query.ts',
    'packages/tools/src/tables/read.ts',
    'packages/tools/src/tables/rows.ts',
    'server/api/src/agent/extract/index-writes.ts',
    'server/api/src/main.ts',
    'server/web/app/api/tables/[id]/draft-ops/route.ts',
    'server/web/app/api/tables/[id]/export/route.ts',
    'server/web/app/api/tables/[id]/rows/route.ts',
    'server/web/app/s/[token]/aggregate/route.ts',
    'server/web/app/s/[token]/rows/route.ts',
    'server/web/lib/maintenance/files-staged-reap.ts',
    'server/web/lib/sanity/checks.ts',
    'server/web/lib/shares.ts',
    'server/web/scripts/merge-part-tables.ts',
    'server/web/scripts/retire-table-blobs.ts',
  ],
};

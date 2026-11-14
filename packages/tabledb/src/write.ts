/**
 * The tables store's WRITE API (docs/store-brokers.md):
 * what changes a workbook file in the store. Only the tables broker
 * (packages/content/src/table-broker.ts) imports it; the store-brokers lint
 * pins that. Readers keep the package's root entry.
 */
export { patchDocFile, writeDocFile } from './engine';
export type { PatchDocMeta } from './engine';
export { applyOpsToFile, finalizePublishedFile } from './ops';
export { openTableFile } from './sqlite';

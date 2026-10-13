/**
 * The object store's WRITE API (workspaces arch A3b, docs/store-brokers.md):
 * only the store brokers import it; the store-brokers lint pins who does.
 * Readers keep `@mantle/storage`.
 */
export { copyMissingFrom, deleteContent, ensureBucket, putContent } from './index';

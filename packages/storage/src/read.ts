/**
 * The object store's READ API, the package's root entry
 * (docs/store-brokers.md). What writes the store (put, delete, make the
 * bucket, copy from another) is `@mantle/storage/write`, which only the
 * brokers import (the store-brokers lint pins them).
 */
export {
  bucketReachable,
  bucketStatus,
  clientConfig,
  contentKey,
  getContent,
  hashBuffer,
  listKeys,
  verifyObjects,
  __setClientForTests,
  type BucketStatus,
  type CopyReport,
  type StoredObject,
  type VerifyReport,
} from './index';

/**
 * Moved to @mantle/web-ui/model-choices with the server/client split — the
 * onboarding CLIENT renders these lists, so the pure-data file lives in the
 * shared UI package now. This shim keeps the manifest's canonical import path
 * (and the single-source rule) intact for server-side consumers.
 */
export * from '@mantle/web-ui/model-choices';

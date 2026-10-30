/**
 * Thin re-export: the "does this key work?" probe lives in @mantle/api-keys
 * (probe.ts), beside the vault's write gateway that runs a key's Test.
 * Onboarding's sanity checks call it here.
 */
export { probeApiKey, type TestApiKeyResult } from '@mantle/api-keys';

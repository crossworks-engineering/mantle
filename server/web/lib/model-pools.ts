/** Shim preserving the `@/lib/model-pools` import path — the catalog moved to
 *  @mantle/client-types so packages/tools (the curator tools) can read it. */
export * from '@mantle/client-types/model-pools';

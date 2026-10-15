/**
 * Provider error classes (2026-10-04). Two brains used OpenAI direct for
 * embeddings while the account had no credits; OpenAI answered
 * `429 insufficient_quota`, which looks like a rate limit, so every extract
 * job burned its retries and went to the dead-letter queue, for days.
 *
 * The classifier lives in @mantle/std provider-error.ts since A10 #10, beside
 * the structured ProviderHttpError and the chat retry and failover readers.
 * This path stays for its importers (the extract circuit, chat failover).
 */
export {
  PROVIDER_ERROR_REASONS,
  classifyProviderError,
  isAccountError,
  providerErrorStatus,
  type ProviderErrorClass,
  type ProviderErrorCode,
} from '@mantle/std';

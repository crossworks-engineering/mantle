/**
 * Provider error classes. A provider account with no credits answers
 * `429 insufficient_quota`, which looks like a rate limit: read as one,
 * every extract job burns its retries and goes to the dead-letter queue.
 *
 * The classifier lives in @mantle/std provider-error.ts, beside
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

/**
 * `captureLlmUsage` + `recordChatUsage` live in `@mantle/tracing` so tool
 * handlers (which can't import agent-runtime without a dependency cycle) can
 * attribute LLM cost too. Re-exported here to keep the `@mantle/agent-runtime`
 * import path stable for the extractor / summarizer / reflector / tool-loop
 * callers — including the Phase 3 migration to `recordChatUsage`.
 */

export {
  captureLlmUsage,
  recordChatUsage,
  type ChatUsageResult,
  type LlmUsageSink,
} from '@mantle/tracing';

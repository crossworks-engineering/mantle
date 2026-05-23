/**
 * `captureLlmUsage` moved to `@mantle/tracing` so tool handlers (which can't
 * import agent-runtime without a dependency cycle) can attribute LLM cost too.
 * Re-exported here to keep the `@mantle/agent-runtime` import path stable for
 * the extractor / summarizer / reflector / tool-loop callers.
 */

export { captureLlmUsage, type LlmUsageSink } from '@mantle/tracing';

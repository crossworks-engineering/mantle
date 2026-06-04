export {
  buildChatMessages,
  buildAttachmentContextText,
  flattenChatMessagesForAdapter,
  type HistoryTurn,
  type Digest,
  type FactSnippet,
  type ContentHit,
  type ChunkContextHit,
  type RelationLine,
  type ChatMessage,
  type ToolCallRequest,
  type UserImage,
} from './messages';

export {
  captureLlmUsage,
  recordChatUsage,
  type ChatUsageResult,
} from './llm-usage';

export {
  runToolLoop,
  resolveAgentTools,
  buildToolsForModel,
  type ToolLoopArgs,
  type ToolLoopResult,
} from './tool-loop';

export {
  resolveChatRoutes,
  resolveRouteAdapter,
  resolveBackupAdapter,
  resolveChatKey,
  isChatFailover,
  chatWithFailover,
  type ChatKeyResult,
  type ChatRoute,
  type ChatRoutes,
  type ChatRouteRow,
  type ResolvedChatRoute,
  type RoutelessChatOptions,
  type ChatWithFailoverResult,
} from './chat-failover';

export {
  resolveAgentSkills,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  type SkillForRuntime,
} from './skills';

export { invokeAgent } from './invoke-agent';

export {
  recordTurn,
  loadConversationContext,
  type ConversationContext,
} from './conversation';

export {
  runVisionWorker,
  runDocumentWorker,
  documentWorkerPrefersNative,
  extractAttachmentForTurn,
  questionAwareVisionPrompt,
  DOC_TEXT_MAX,
  type VisionResult,
  type AttachmentExtract,
} from './attachments';

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

export { captureLlmUsage, recordChatUsage, type ChatUsageResult } from './llm-usage';

export {
  runToolLoop,
  resolveAgentTools,
  buildToolsForModel,
  summarizeToolOutcomes,
  resolveToolValidationMode,
  type ToolValidationMode,
  type ToolOutcomeStats,
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
  resolveAgentToolGroups,
  resolveToolGroupSkillSlugs,
  composeSystemPromptWithSkills,
  applyAgentName,
  AGENT_NAME_TOKEN,
  effectiveSkillSlugs,
  effectiveToolSlugs,
  type SkillForRuntime,
  type ComposePromptOptions,
} from './skills';

export { invokeAgent } from './invoke-agent';

export {
  recordTurn,
  updateAssistantMessageOutcome,
  markTurnSuperseded,
  loadConversationContext,
  looksAnaphoricFollowup,
  type ConversationContext,
  type ContextSnapshot,
  type SnapshotItem,
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

/** Re-exported from @mantle/tools so turn-assembly code can ask "is this tool
 *  safe for a read-only turn?" without importing the whole builtin barrel
 *  (which drags every domain package into the module graph). */
export { isBuiltinReadOnly, listReadOnlyBuiltinSlugs } from '@mantle/tools';

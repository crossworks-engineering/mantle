export {
  buildChatMessages,
  fenceRetrieved,
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
  runToolLoop,
  resolveAgentTools,
  buildToolsForModel,
  loopToolRows,
  DEFAULT_MAX_ITERATIONS,
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
  chatRouteKeyRefusal,
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

export {
  ARCHIVE_SUMMARY_PROMPT,
  ChatArchiveBusyError,
  ChatThreadNotFoundError,
  archiveAgentChat,
  summarizeChatThread,
  withChatNoteHome,
  type ChatArchiveResult,
} from './chat-archive';
export { invokeAgent } from './invoke-agent';
export {
  AgentWorkspaceError,
  agentTurnScoped,
  agentWorkspaceKind,
  ownerSurfaceLogin,
  surfaceLoginId,
  withAgentScope,
  withAgentViewer,
  withRunScope,
} from './agent-viewer';

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
// The passage cut, for the eval harnesses (scripts/eval-route.ts).
export {
  CHUNK_CUTOFF,
  KEYWORD_PASSAGE_RULE,
  keywordPassages,
  selectChunkHits,
  type KeywordPassageRule,
} from './conversation/select';

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

export {
  runScanReader,
  cleanParsedText,
  parsedPictureCount,
  SCAN_READER_ENGINE,
  SCAN_READER_ENGINE_MAX_TOKENS,
  type ScanReaderResult,
} from './scan-reader';
export {
  readScannedPdf,
  scanVerdictOf,
  scanTextOf,
  scanCountsOf,
  scanUnreadSentence,
  pageMarksOf,
  FIGURE_TEXT_MAX_CHARS,
  SCAN_WINDOW,
  SCAN_PAGES_AT_ONCE,
  SCAN_UNREAD_REASONS,
  SCAN_RETRY_REASONS,
  scanPageFinal,
  type ScanPage,
  type ScanPageMethod,
  type ScanUnreadReason,
  type ScanVerdict,
  type ScanPdfResult,
  type ScanPdfDeps,
} from './scan-pdf';
export {
  scanReadQualityOf,
  SCAN_READ_ANCHORS_MIN,
  type OcrWord,
  type ScanReadBadReason,
  type ScanReadQuality,
} from './scan-reader-quality';

/** Re-exported from @mantle/tools so turn-assembly code can ask "is this tool
 *  safe for a read-only turn?" without importing the whole builtin barrel
 *  (which drags every domain package into the module graph). */
export { builtinPolicy, isBuiltinReadOnly, listReadOnlyBuiltinSlugs } from '@mantle/tools';

/**
 * @mantle/content · team
 *
 * Team and forum — the shared surfaces: threads, uploads, the hub, membership, notifications and share links.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  SHAREABLE_TYPES,
  isShareable,
  isShareableFolderPath,
  listActiveShares,
  type ActiveShareListing,
  getActiveShareForNode,
  createShare,
  revokeShare,
  resolveActiveShareByToken,
  recordShareView,
  publicBaseUrl,
  shareUrlForToken,
  nodeUrl,
  appUrl,
  shareModeOf,
  setShareMode,
  shareCascadeOf,
  setShareCascade,
  applyShareMode,
  revokeShareTree,
  listPageDescendantIds,
  type ShareMode,
  type ShareableType,
  type ShareSummary,
} from './shares';

export {
  listTeamHubSections,
  listTeamApps,
  teamHubContentCounts,
  resolveTeamHubApp,
  TEAM_HUB_STAT_TYPES,
  TEAM_WORKSPACE_TYPES,
  TEAM_SHARE_SORTS,
  listTeamVisibleShares,
  pageTeamVisibleShares,
  listTeamShareTags,
  countTeamVisibleShares,
  curatedTeamSections,
  TEAM_CURATED_SECTION_LIMIT,
  type CuratedTeamSection,
  type TeamHubSection,
  type TeamAppCard,
  type TeamHubStatType,
  type TeamHubApp,
  type TeamWorkspaceType,
  type TeamShareSort,
  type TeamVisibleShare,
  type TeamVisibleSharePage,
} from './team-hub';

export {
  appendTeamMessage,
  updateTeamMessageOutcome,
  countTeamInboundSince,
  listTeamThread,
  recentTeamMessages,
  listTeamMemberActivity,
  markTeamThreadRead,
  type AppendTeamMessageInput,
  type UpdateTeamMessageOutcomeInput,
  type TeamMemberActivity,
  teamThreadHasAttachedNode,
} from './team-messages';

export {
  listNotifiableMembers,
  notifyMembers,
  replyToNotification,
  listNotifications,
  readThread,
  markThreadRead,
  countUnreadNotifications,
  MAX_NOTIFY_RECIPIENTS,
  MAX_NOTIFICATION_BODY,
  TEAM_NOTIFICATION_CHANNEL,
  TEAM_NOTIFICATION_TYPE,
  type NotifiableMember,
  type TeamNotificationRow,
  type NotifyInput,
  type NotifyResult,
} from './team-notifications';

export {
  listTeamRequests,
  notifyTeamRequester,
  TEAM_REQUEST_TAG,
  type TeamRequest,
  type NotifyTeamRequesterResult,
} from './team-requests';

export {
  createForumTopic,
  appendForumPost,
  acquireForumAgentPending,
  finalizeForumPost,
  getForumPost,
  listForumTopics,
  countForumTopics,
  FORUM_TOPIC_SORTS,
  getForumTopic,
  listForumPosts,
  searchForumPosts,
  recentForumPosts,
  countForumMemberPostsSince,
  listForumMemberActivity,
  listForumPostsByContact,
  countForumPostsByContact,
  listForumTopicsByAuthor,
  sweepStaleForumAgentPosts,
  markForumTopicRead,
  setForumTopicPinned,
  setForumTopicStatus,
  type ForumViewer,
  type ForumAuthor,
  type CreateForumTopicInput,
  type AppendForumPostInput,
  type FinalizeForumPostInput,
  type ForumTopicListItem,
  type ForumTopicSort,
  type ForumPostMatch,
  type ForumMemberActivity,
  type ForumMemberPost,
  type ForumAuthoredTopic,
  forumTopicsWithAttachedNode,
} from './forum';

export {
  listStagedForumUploads,
  bindForumUploadsTx,
  getForumUpload,
  listForumUploadStatesForTopic,
  listPendingForumUploads,
  countPendingForumUploads,
  markForumUploadFiled,
  markForumUploadDismissed,
  stageForumUploadsWithinBudget,
  deleteStaleStagedForumUploads,
  deleteStagedForumUploadRow,
  listForumUploadStatusesByIds,
  type StageForumUploadInput,
  type StageForumUploadFile,
  type PendingForumUpload,
} from './forum-uploads';

export {
  attachmentKindForMime,
  topicFolderSlug,
  dedupeFilename,
  formatAttachmentSize,
  type ForumAttachmentKind,
} from './forum-uploads-meta';

export {
  recordTeamAccess,
  listTeamAccess,
  type TeamAccessKind,
  type TeamAccessEntry,
  type TeamAccessRow,
} from './team-access-log';
export {
  enableTeamMember,
  disableTeamMember,
  rotateTeamToken,
  verifyTeamToken,
  teamStatusByContact,
  teamStatusFor,
  isTeamMember,
  markTeamTokenUsed,
  generateTeamToken,
  hashTeamToken,
  TEAM_TOKEN_LENGTH,
  type TeamStatus,
} from './team-tokens';

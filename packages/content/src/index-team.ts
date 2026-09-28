/**
 * @mantle/content · team
 *
 * Team: member chat threads, requests, membership, invites, levels, personal
 * spaces and share links (the team-code portal and forum retired in Phase 6).
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
  isRetiredTeamLinkToken,
  recordShareView,
  publicBaseUrl,
  shareUrlForToken,
  nodeUrl,
  appUrl,
  shareCascadeOf,
  setShareCascade,
  applyShareMode,
  revokeShareTree,
  listPageDescendantIds,
  canShareNode,
  shareModeForLevel,
  levelForShareMode,
  applyLevelToShare,
  TeamLinkRetiredError,
  type ShareMode,
  type ShareableType,
  type ShareSummary,
} from './shares';

export {
  appendTeamMessage,
  updateTeamMessageOutcome,
  listLoginPortalThread,
  listTeamThread,
  PRIVATE_REPLY_PLACEHOLDER,
  redactPrivateReply,
  recentTeamMessages,
  listTeamMemberActivity,
  listMemberChatActivity,
  type AppendTeamMessageInput,
  type UpdateTeamMessageOutcomeInput,
  type TeamMemberActivity,
  type MemberChatActivity,
} from './team-messages';

export {
  claimMemberTurn,
  releaseMemberTurn,
  memberTokensSince,
  type MemberTurnLimits,
  type ClaimMemberTurnResult,
} from './member-turn-ledger';

export {
  listTeamRequests,
  notifyTeamRequester,
  countTeamRequestsFiled,
  markTeamRequestReviewed,
  TEAM_REQUEST_TAG,
  TEAM_REQUESTS_PER_TURN,
  TEAM_REQUESTS_PER_DAY,
  type TeamRequest,
  type NotifyTeamRequesterResult,
} from './team-requests';

export { dedupeFilename } from './dedupe-filename';

export {
  recordTeamAccess,
  listTeamAccess,
  type TeamAccessKind,
  type TeamAccessEntry,
  type TeamAccessRow,
} from './team-access-log';
export {
  INVITE_CODE_ALPHABET,
  MEMBER_INVITE_CODE_LENGTH,
  MEMBER_INVITE_TTL_MS,
  MemberInviteError,
  createMemberInvite,
  generateInviteCode,
  hashInviteCode,
  inviteLinkPath,
  listMemberInvites,
  previewMemberInvite,
  redeemMemberInvite,
  revokeMemberInvite,
  type CreateMemberInviteInput,
  type MemberInviteErrorReason,
  type RedeemMemberInviteInput,
  type RedeemedMemberInvite,
} from './member-invites';

// Levels: admin > team > client > public (member logins Phase 0b).
export {
  AccessError,
  accessClosure,
  agentGrantProblems,
  isWorkspaceKind,
  setAgentAudience,
  setItemAudience,
  setItemLevel,
  setToolGroupAudience,
  unshareItem,
  type AccessItem,
  type SetItemAudienceResult,
  type SetItemLevelResult,
  type UnshareItemResult,
} from './access';
export {
  accessShadowReport,
  idsUsedByStep,
  type AccessShadowReport,
  type ShadowItem,
} from './access-shadow';
export {
  LIBRARY_KINDS,
  getLibraryItem,
  isLibraryKind,
  listLibrary,
  libraryCounts,
  type LibraryItem,
  type LibraryKind,
  type LibraryRow,
} from './member-library';
export {
  SPACE_ITEM_KINDS,
  SPACE_ITEM_LIMIT,
  SpaceItemStateError,
  assertEditable,
  createMineItem,
  deleteMineItem,
  getMineItem,
  getMineRow,
  getTeamDraftDrawSvg,
  getTeamDraftItem,
  isSpaceItemKind,
  listMine,
  listTeamDrafts,
  recallItem,
  setSharing,
  submitItem,
  updateMineItem,
  saveMineTable,
  saveMinePage,
  saveMineDraw,
  getTeamDraftRow,
  disallowedPageRefs,
  disallowedRefs,
  openTeamDraftFile,
  type CreateSpaceItemInput,
  type ListSpaceOpts,
  type SpaceItemBody,
  type SpaceItemKind,
  type SpaceItemRow,
  type SpaceWriter,
  type UpdateSpaceItemInput,
} from './member-space';
export {
  SPACE_DAILY_UPLOAD_BYTES,
  SPACE_FILES_PATH,
  SPACE_FILE_MAX_BYTES,
  SPACE_STORAGE_LIMIT_BYTES,
  cleanSpaceFilename,
  createMineFile,
  openMineFile,
  spaceStorageUsed,
  spaceUploadHeadroom,
  assertSpaceStorage,
  type OpenedSpaceFile,
  type SpaceFile,
} from './member-space-files';
export {
  addMineComment,
  addTeamDraftComment,
  deleteMineComment,
  deleteTeamDraftComment,
  listMineComments,
  listTeamDraftComments,
  type SpaceCommentAuthor,
} from './member-space-comments';
export {
  BUNDLE_MAX_ITEMS,
  ReviewError,
  acceptOwnItem,
  acceptReviewItem,
  addReviewComment,
  countSubmitted,
  deleteReviewComment,
  discardLeftBehind,
  getReviewItem,
  listReviewComments,
  listReviewQueue,
  openReviewFile,
  previewAccept,
  returnReviewItem,
  reviewDrawSvg,
  type AcceptOptions,
  type AcceptResult,
  type Bundle,
  type BundleItem,
  type ReviewAuthor,
  type ReviewItemRow,
  type ReviewReason,
} from './member-review';
export {
  acceptedAuthors,
  acceptedDrawSvg,
  acceptedRow,
  getAcceptedItem,
  isAuthorOfAcceptedFile,
  listAccepted,
  type AcceptedAuthor,
  type AcceptedItem,
  type AcceptedRow,
} from './member-accepted';
export { memberDrawSvg, memberVisibleDrawFileIds } from './member-draw-images';
export {
  SPACE_PURGE_GRACE_DAYS,
  findSpacePurge,
  purgeDeactivatedSpaces,
  type SpacePurgeCandidate,
  type SpacePurgeResult,
} from './member-space-purge';
export {
  SPACE_ITEM_CHANGED_CHANNEL,
  parseSpaceItemChange,
  type SpaceItemChange,
  type SpaceItemChangeKind,
} from './member-space-events';

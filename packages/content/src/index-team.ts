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
  isRetiredClientLinkToken,
  listRetiredClientLinks,
  type RetiredClientLinkListing,
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
  ClientLinkRetiredError,
  type ShareMode,
  type ShareableType,
  type ShareSummary,
  type ShareCascadeResult,
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
  clientChatUsageSince,
  type MemberTurnLimits,
  type ClaimMemberTurnResult,
} from './member-turn-ledger';

export {
  listTeamRequests,
  countOpenTeamRequests,
  notifyTeamRequester,
  countTeamRequestsFiled,
  countClientRequestFilings,
  recordClientRequestFiling,
  markTeamRequestReviewed,
  TEAM_REQUEST_TAG,
  TEAM_REQUESTS_PER_TURN,
  TEAM_REQUESTS_PER_DAY,
  CLIENT_REQUEST_TAG,
  CLIENT_REQUESTS_PER_TURN,
  CLIENT_REQUESTS_PER_DAY,
  type TeamRequest,
  type NotifyTeamRequesterResult,
} from './team-requests';

export {
  NEEDS_YOU_CHANGED_CHANNEL,
  NEEDS_YOU_REALTIME_TYPE,
  loadNeedsYou,
  type NeedsYou,
} from './needs-you';

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
// Embedding means sharing: an item's embeds follow it down (audit F19 follow-up).
export {
  EMBEDDING_KINDS,
  EMBED_RECONCILE_VERSION,
  drawPlacedFileIds,
  embedClosure,
  findEmbedClosureGaps,
  levelAbove,
  lowerEmbedClosure,
  reconcileEmbedClosures,
  reconcileEmbedClosuresOnce,
  type EmbedClosureGap,
  type EmbedItem,
  type LoweredItem,
} from './embed-closure';
export {
  LIBRARY_KINDS,
  getLibraryItem,
  isLibraryKind,
  listLibrary,
  libraryCounts,
  libraryLevelsOf,
  type LibraryAudience,
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
  isWithAdmin,
  listWithAdmin,
  withAdminError,
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
  saveMineDraft,
  saveMineDraw,
  getTeamDraftRow,
  disallowedPageRefs,
  disallowedRefs,
  openTeamDraftFile,
  type CreateSpaceItemInput,
  type ListSpaceOpts,
  type SpaceListSort,
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
  clientSpacesUsed,
  withClientTextRoom,
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
  acceptAudience,
  acceptOwnItem,
  acceptReviewItem,
  addReviewComment,
  countReviewQueue,
  countSubmitted,
  deleteReviewComment,
  discardLeftBehind,
  getReviewItem,
  listReviewComments,
  listReviewQueue,
  newestSubmitted,
  openReviewFile,
  previewAccept,
  returnReviewItem,
  reviewDrawSvg,
  takeOverReviewItem,
  type TakeOverResult,
  type AcceptClosureItem,
  type AcceptOptions,
  type AcceptResult,
  type Bundle,
  type BundleItem,
  type ReviewAuthor,
  type ReviewAuthorRole,
  type ReviewItemRow,
  type ReviewReason,
} from './member-review';
export {
  acceptedAuthors,
  acceptedByLogin,
  acceptedDrawSnapshot,
  acceptedDrawSvg,
  acceptedFileMeta,
  acceptedFileReadable,
  acceptedRow,
  getAcceptedItem,
  getClientAcceptedItem,
  isAuthorOfAcceptedFile,
  listAccepted,
  type AcceptedAuthor,
  type AcceptedItem,
  type AcceptedReader,
  type AcceptedRow,
} from './member-accepted';
export {
  acceptedItemRow,
  clientAcceptedItemRow,
  clientItemsPlan,
  clientOwnItemRow,
  clientRequestItemRow,
  itemsPlan,
  libraryItemRow,
  mergeNewestFirst,
  mergeSorted,
  listSortCompare,
  pillOf,
  spaceItemRow,
  MEMBER_ITEMS_MAX_PAGE,
  type ClientItemsPlan,
  type ItemsPlan,
  type PagedSource,
} from './member-items';
export {
  CLIENT_COMMENTS_PER_DAY,
  CLIENT_DOC_MAX_BYTES,
  CLIENT_NOTE_MAX_CHARS,
  CLIENT_SPACES_TOTAL_BYTES,
  CLIENT_SPACE_LIMITS,
  THREAD_COMMENT_LIMIT,
  clientSpacesTotalBytes,
  MEMBER_SPACE_LIMITS,
  inClientSpace,
  spaceLimits,
  type SpaceLimits,
} from './space-limits';
export {
  clientStorageRows,
  clientAppDbBytes,
  clientThreadActivity,
  deleteClientComments,
  type ClientStorageRow,
  type ClientThreadActivityRow,
} from './client-admin-usage';
export {
  CLIENT_QUOTA_REFUSAL_DAYS,
  listClientQuotaRefusals,
  recordClientQuotaRefusal,
  type ClientQuotaReason,
  type ClientQuotaRefusal,
} from './client-quota-log';
export { memberDrawSvg, memberVisibleDrawFileIds } from './member-draw-images';
export { giveBackTakenItem, takenFromOf, type GiveBackResult } from './member-takeover';
export {
  SNAPSHOT_TABLE_OWNER,
  acceptedFileUnchanged,
  snapshotOf,
  snapshotTableAbs,
  type AcceptedSnapshot,
} from './member-snapshots';
export { settleSpaceOnPromotion } from './member-space-login';
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
export {
  CLIENT_REPORT_MAX,
  ClientReportChangedError,
  acknowledgeClientReport,
  clientReport,
  clientReportAcknowledged,
  clientReportFingerprint,
} from './client-report';
export { oldLinksAbove, oldLinksAboveItem } from './client-old-links';
export { readThroughEmbeds, sharedViaFolder } from './shared-via';
// Client logins (C2): Team admin > Clients and the sign-in link.
export {
  CLIENT_SIGNIN_LINK_TTL_MS,
  ClientLoginError,
  clientSigninLinkPath,
  clientTurnMayRun,
  createClientLogin,
  issueClientSigninLink,
  listClientLogins,
  redeemClientSigninLink,
  revokeClientSigninLink,
  revokeOpenClientSignins,
  type CreateClientLoginInput,
  type RedeemedClientSigninLink,
} from './client-logins';
// Client logins (C2): what a client reads ("Shared with you", redacted bodies,
// drawing images at client level).
export { clientReadableIds, getClientSharedItem, listClientShared } from './client-shared';
export { docRefIds, noteRefIds, redactClientDoc, redactClientNote } from './client-redact';
export { clientDrawSvg, clientVisibleDrawFileIds } from './client-draw-images';
// Client logins (C6): pictures in a member's or a client's own chat thread
// point at the reader's own routes, and only at items the reader may read.
export {
  chatImageIds,
  chatImageSrc,
  chatImagesFor,
  chatTextsForReader,
  rewriteChatImages,
  type ChatImageKind,
  type ChatImageReader,
} from './chat-images';
// Client logins (C5): clients' submitted items for members (decision 5 B),
// and the client thread on client-level items (decision 8).
export {
  getClientRequestItem,
  listClientRequests,
  openClientRequestFile,
  type ClientRequestRow,
  type ListClientRequestsOpts,
} from './client-requests';
export {
  addClientThreadComment,
  deleteClientThreadComment,
  listClientThread,
  type ClientThreadAuthor,
} from './client-thread';
// Client logins (C2b): email sign-in codes.
export {
  CLIENT_CODE_CAP_REASONS,
  CLIENT_CODE_DAILY_CAP,
  CLIENT_CODE_IP_RETENTION_DAYS,
  CLIENT_CODE_MAX_ATTEMPTS,
  CLIENT_CODE_PER_EMAIL_HOURLY,
  CLIENT_CODE_PER_EMAIL_IP_DAILY,
  CLIENT_CODE_PER_EMAIL_IP_HOURLY,
  CLIENT_CODE_PER_LOGIN_DAILY,
  CLIENT_CODE_REQUEST_MAX_AGE_MS,
  CLIENT_CODE_ROW_RETENTION_DAYS,
  CLIENT_CODE_TTL_MS,
  clientCodeFailureReason,
  clientCodeStats,
  clientCodesSentLast24h,
  createClientEmailCode,
  generateClientCode,
  hashClientCode,
  markClientEmailCodeSent,
  reapClientSigninCodes,
  redeemClientEmailCode,
  revokeClientEmailCode,
  type ClientCodeCapReason,
  type ClientCodeDecision,
  type ClientCodeRequest,
  type ClientCodeSkipReason,
  type ClientCodeStats,
  type RedeemedClientEmailCode,
} from './client-codes';

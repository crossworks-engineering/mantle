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
  getLiveShare,
  createShare,
  setShareServed,
  shareServedIds,
  revokeShare,
  resolveActiveShareByToken,
  resolveActiveShareRowByToken,
  isRetiredTeamLinkToken,
  isRetiredClientLinkToken,
  listRetiredClientLinks,
  type RetiredClientLinkListing,
  recordShareView,
  publicBaseUrl,
  shareUrlForToken,
  nodeUrl,
  appUrl,
  applyShareMode,
  revokeShareTree,
  canShareNode,
  shareModeForLevel,
  applyLevelToShare,
  TeamLinkRetiredError,
  ShareInputError,
  type ShareMode,
  type ShareableType,
  type ShareSummary,
} from './shares';

export {
  LinkRefusedError,
  assertMayLink,
  checkServeList,
  FOLDER_SERVE_OFFER_MAX,
  linkRights,
  listServeCandidates,
  type LinkRights,
} from './link-serve';

export {
  CONTACT_CODE_LENGTH,
  CONTACT_CODE_DAILY_FAILURES,
  CONTACT_CODE_LOCK_MS,
  CONTACT_CODE_SHARE_HOURLY_FAILURES,
  generateContactCode,
  normalizeContactCode,
  hashContactCode,
  contactSharingByContact,
  contactSharingFor,
  enableContactSharing,
  regenerateContactCode,
  disableContactSharing,
  contactShareGateRow,
  checkContactShareCode,
  lockedContactSharing,
  type ContactSharingStatus,
  type ContactShareGateRow,
  type EnableContactSharingResult,
} from './contact-share-codes';

export {
  ContactShareRefusedError,
  CONTACT_SHAREABLE_TYPES,
  CONTACT_MENU_LIMIT,
  CONTACT_SHARES_PAGE,
  createContactShares,
  setContactShareCanWrite,
  revokeAllContactShares,
  listContactShares,
  listContactSharesForAdmin,
  contactSharesForNode,
  getContactShare,
  type ContactMenuItem,
} from './contact-shares';

export {
  recordShareAccess,
  listShareAccess,
  reapShareAccessLog,
  SHARE_ACCESS_LOG_RETENTION_DAYS,
  type ShareAccessEntry,
  type ShareAccessRow,
} from './share-access-log';

export {
  appendThreadMessage,
  updateThreadMessageOutcome,
  recentThreadMessages,
  threadMessageById,
  listTeamThread,
  PRIVATE_REPLY_PLACEHOLDER,
  redactPrivateReply,
  listTeamMemberActivity,
  type ThreadMessage,
  type AppendThreadMessageInput,
  type UpdateThreadMessageOutcomeInput,
  type TeamMemberActivity,
} from './team-messages';

export {
  claimMemberTurn,
  releaseMemberTurn,
  memberTokensSince,
  memberDailyLimits,
  clientChatUsageSince,
  type MemberTurnLimits,
  type ClaimMemberTurnResult,
} from './member-turn-ledger';

export {
  countOpenTeamRequests,
  countTeamRequestsFiled,
  countClientRequestFilings,
  recordClientRequestFiling,
  TEAM_REQUEST_TAG,
  TEAM_REQUESTS_PER_TURN,
  TEAM_REQUESTS_PER_DAY,
  CLIENT_REQUEST_TAG,
  CLIENT_REQUESTS_PER_TURN,
  CLIENT_REQUESTS_PER_DAY,
} from './team-requests';

// Provider outages (0230) and the live event that still carries them.
export {
  NEEDS_YOU_CHANGED_CHANNEL,
  NEEDS_YOU_REALTIME_TYPE,
  loadProviderAlerts,
} from './provider-alerts';

export { dedupeFilename } from './dedupe-filename';

export {
  recordTeamAccess,
  listTeamAccess,
  contactTitles,
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

// The plain unshare (agent and tool-group levels went in workspaces W7b).
export { AccessError, isWorkspaceKind, unshareItem, type UnshareItemResult } from './access';
export { teamReadsItem } from './team-grant';
export {
  teamAssistant,
  workspaceAssistantFor,
  workspaceAssistants,
  type TeamAssistant,
  type WorkspaceAssistant,
} from './team-assistant';
// What an item embeds (W5b2: an embed never changes who reads anything).
// LoweredItem is a deprecated type: callers go in the writers/links helpers.
export { EMBEDDING_KINDS, drawPlacedFileIds, type LoweredItem } from './embed-closure';
export {
  LIBRARY_KINDS,
  getLibraryItem,
  isLibraryKind,
  listLibrary,
  libraryCounts,
  libraryHolds,
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
  isSpaceItemKind,
  listMine,
  recallItem,
  setSharing,
  submitItem,
  updateMineItem,
  saveMineTable,
  saveMinePage,
  saveMineDraft,
  saveMineDraw,
  disallowedPageRefs,
  disallowedRefs,
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
  acceptedAuthors,
  acceptedByLogin,
  acceptedDrawSnapshot,
  acceptedDrawSvg,
  acceptedFileMeta,
  acceptedFileReadable,
  acceptedRow,
  getAcceptedItem,
  acceptedItemForCopy,
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
  CLIENT_DOC_MAX_BYTES,
  CLIENT_NOTE_MAX_CHARS,
  CLIENT_SPACES_TOTAL_BYTES,
  CLIENT_SPACE_LIMITS,
  clientSpacesTotalBytes,
  MEMBER_SPACE_LIMITS,
  inClientSpace,
  spaceLimits,
  type SpaceLimits,
} from './space-limits';
// A deleted client login's old comments go with it (the login delete).
export { deleteClientComments } from './client-comments';
export {
  CLIENT_QUOTA_REFUSAL_DAYS,
  listClientQuotaRefusals,
  recordClientQuotaRefusal,
  type ClientQuotaReason,
  type ClientQuotaRefusal,
} from './client-quota-log';
export { memberDrawSvg, memberVisibleDrawFileIds, scopedDrawSvg } from './member-draw-images';
export { takenFromOf } from './admin-space-taken';
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
export { readThroughEmbeds, sharedViaFolder } from './shared-via';
// Client logins: what the kept email code sign-in and the login lifecycle
// need (the client portal and sign-in links went in workspaces W5c).
export { clientTurnMayRun, revokeOpenClientSignins } from './client-logins';
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
export {
  LOGIN_NOTICE_CHANNEL,
  LOGIN_NOTICE_FRESH_MS,
  chatReplyNotice,
  chatTeaser,
  parseLoginNotice,
  reviewResultNotice,
  type LoginNotice,
  type LoginNoticeMessage,
  type LoginNoticeRole,
} from './login-notices';
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

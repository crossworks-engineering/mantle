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
  LINK_APP_NO_MANAGE_MESSAGE,
  LINK_NO_EDIT_MESSAGE,
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
  setContactShareCanWrite,
  listContactShares,
  listContactSharesForAdmin,
  contactSharesForNode,
  getContactShare,
  type ContactMenuItem,
} from './contact-shares';

export {
  AdminActRefusedError,
  adminContactSharing,
  adminRevokeAllContactShares,
  adminCreateContactShares,
  adminMergeEntities,
  adminCloseShare,
  adminSetContactShareCanWrite,
  adminAppTrashAct,
} from './admin-acts';
export type { AppTrashOutcome, ContactShareWriteOutcome } from './admin-acts';
export type {
  ContactSharingAction,
  ContactSharingActResult,
  ContactSharingOutcome,
} from './contact-share-codes';

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
  type ThreadMessage,
  type AppendThreadMessageInput,
  type UpdateThreadMessageOutcomeInput,
} from './team-messages';

export {
  claimMemberTurn,
  releaseMemberTurn,
  memberTokensSince,
  memberDailyLimits,
  type MemberTurnLimits,
  type ClaimMemberTurnResult,
} from './member-turn-ledger';

export { countOpenTeamRequests, TEAM_REQUEST_TAG } from './team-requests';

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
export {
  FORMER_CLIENT_CONTACT_MESSAGE,
  FORMER_CLIENT_EMAIL_MESSAGE,
  FORMER_CLIENT_ENABLE_MESSAGE,
  isFormerClientContact,
  isFormerClientEmail,
  isFormerClientLogin,
} from './former-clients';

// The plain unshare (agent and tool-group levels went in workspaces W7b).
export { AccessError, isWorkspaceKind, unshareItem, type UnshareItemResult } from './access';
export {
  defaultWorkspaceAssistant,
  workspaceAssistantFor,
  workspaceAssistants,
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
export { acceptedItemForCopy, type AcceptedItem, type AcceptedRow } from './member-accepted';
// Paging one list merged from several sources (moved out of member-items, W8d).
export { listSortCompare, mergeSorted, type ListSort, type PagedSource } from './list-merge';
export {
  SNAPSHOT_TABLE_OWNER,
  acceptedFileUnchanged,
  snapshotOf,
  snapshotTableAbs,
  type AcceptedSnapshot,
} from './member-snapshots';
export { settleSpaceOnPromotion } from './member-space-login';
export { readThroughEmbeds, sharedViaFolder } from './shared-via';
export { docRefIds, noteRefIds, redactClientDoc, redactClientNote } from './client-redact';
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

/**
 * The member API's wire shapes (member logins, Phase 1): what a MEMBER login's
 * client reads from /api/member/*. A member reads team-level items only (the
 * brain enforces it with row security) and chats with the team-level agent in
 * its own thread.
 */
import type { AccessLevel, MemberItemAuthor } from './access';
import type { MemberItemKind } from '../member-kinds';

/** GET /api/member/shell */
export type MemberShell = {
  role: 'member';
  loginId: string;
  displayName: string | null;
  email: string;
  avatar: { style: string; seed: string; parts: unknown } | null;
  avatarPhotoVersion: string | null;
  /** Append as `?at=` to /api/member/files/* and /api/member/draws/* srcs. */
  assetToken: string;
  siteName: string | null;
  colorTheme: string | null;
  fontLogo: string | null;
  fontTitle: string | null;
  fontUi: string | null;
  fontProse: string | null;
  fontSize: string | null;
  fontLogoSize: string | null;
  fontTitleSize: string | null;
  fontProseSize: string | null;
  logoVersion: string | null;
  logoDarkVersion: string | null;
};

export type MemberLibraryKind = MemberItemKind;

export type MemberLibraryRow = {
  id: string;
  type: MemberLibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  audience: AccessLevel;
  updatedAt: string;
  /** A member wrote it and an admin accepted it (the member-authored badge).
   *  Absent from brains before 0.232.285. */
  author?: MemberItemAuthor | null;
};

/** GET /api/member/library?kind=&q=&page= */
export type MemberLibraryPage = {
  items: MemberLibraryRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/member/library/:id -> { item } */
export type MemberLibraryItem =
  | (MemberLibraryRow & { type: 'page'; doc: unknown })
  | (MemberLibraryRow & { type: 'note'; content: string })
  | (MemberLibraryRow & { type: 'table'; table: unknown })
  | (MemberLibraryRow & { type: 'draw' })
  | (MemberLibraryRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

export type MemberChatMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  failed: boolean;
  createdAt: string;
};

/** GET /api/member/chat. `agent` null = chat not open yet (no team-level agent). */
export type MemberChatThread = {
  agent: { slug: string; name: string } | null;
  messages: MemberChatMessage[];
};

// ── Personal spaces (member logins Phase 2) ──────────────────────────────

export type MemberSpaceSharing = 'private' | 'team';
export type MemberReviewState = 'draft' | 'submitted' | 'returned' | 'accepted';

/** One item of a personal space: GET /api/member/space[/team] rows. */
export type MemberSpaceItemRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  sharing: MemberSpaceSharing;
  reviewState: MemberReviewState;
  submittedAt: string | null;
  returnedNote: string | null;
  /** The login that wrote it (team drafts show whose it is). */
  authorLoginId: string | null;
  updatedAt: string;
};

/** GET /api/member/space?kind=&q=&page= (and /space/team) */
export type MemberSpaceList = {
  items: MemberSpaceItemRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** A space file's metadata; the bytes stream from the item's bytes route. */
export type MemberSpaceFile = {
  id: string;
  filename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
};

/**
 * An item's body. The page, drawing and table shapes are the brain's own
 * editor models (content-core); the contract leaves them to the client, which
 * narrows them with `TDoc` / `TTable`.
 */
export type MemberSpaceItemBody<TDoc = unknown, TTable = unknown> =
  | { type: 'page'; page: { doc: TDoc; draft: TDoc | null; draftRev?: number; title: string } }
  | { type: 'note'; note: { content: string; title: string } }
  /** Null for a teammate: their drawing shows from its saved SVG route. */
  | { type: 'draw'; draw: { scene: TDoc; draft: TDoc | null; draftRev?: number } | null }
  | { type: 'table'; table: TTable }
  | { type: 'file'; file: MemberSpaceFile };

/** GET /api/member/space/:id (and the team read): the row and its body. */
export type MemberSpaceItem<TDoc = unknown, TTable = unknown> = {
  row: MemberSpaceItemRow;
  body: MemberSpaceItemBody<TDoc, TTable>;
};

// ── Accepted items (member logins Phase 4, plan 6.2) ────────────────────

/** An item this member wrote and an admin accepted into the brain. */
export type MemberAcceptedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  /** The level the admin chose: at team or lower it is in the Library too. */
  audience: AccessLevel;
  acceptedAt: string | null;
  updatedAt: string;
};

/** GET /api/member/accepted?kind=&page= (brains from 0.232.285) */
export type MemberAcceptedPage = {
  items: MemberAcceptedRow[];
  total: number;
  page: number;
  pageSize: number;
};

/** GET /api/member/accepted/:id -> { item }: the SAVED version, whatever its
 *  level; a drawing shows from /api/member/draws/:id/svg, a file's bytes
 *  from /api/member/files/:id. */
export type MemberAcceptedItem =
  | (MemberAcceptedRow & { type: 'page'; doc: unknown })
  | (MemberAcceptedRow & { type: 'note'; content: string })
  | (MemberAcceptedRow & { type: 'table'; table: unknown })
  | (MemberAcceptedRow & { type: 'draw' })
  | (MemberAcceptedRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/**
 * The member API's wire shapes (member logins, Phase 1): what a MEMBER login's
 * client reads from /api/member/*. A member reads team-level items only (the
 * brain enforces it with row security) and chats with the team-level agent in
 * its own thread.
 */
import type { AccessLevel } from './access';

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

export type MemberLibraryKind = 'page' | 'note' | 'draw' | 'table' | 'file';

export type MemberLibraryRow = {
  id: string;
  type: MemberLibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  audience: AccessLevel;
  updatedAt: string;
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

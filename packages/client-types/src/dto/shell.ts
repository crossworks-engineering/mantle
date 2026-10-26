/**
 * GET /api/shell: the chrome of the one (app) shell, for EVERY login (plan
 * 7.1, workspaces W5c). An admin, a member and a client get the same shape;
 * `role` says which. The brand (site name, theme, fonts, logo) is the
 * brain's; the face (avatar, photo, starred screens) is the login's own.
 * Before W5c a member read /api/member/shell and a client /api/client/shell;
 * both now answer 410 code gone.
 */
import type { TreeKind } from '../tree';
import type { LoginRole } from '../role-names';
import type { ShellWorkspace, WorkspaceArea } from './workspaces';

/** Who is signed in, by role (LOGIN_ROLES, ../role-names). */
export type ShellRole = LoginRole;

/** What this brain can do, so a client branches on capability, not version. */
export type ShellFeatures = {
  recallV2: boolean;
  /** The tree's custom order: the `custom` sort, `ordered` and `mayOrder` on
   *  a folder page, POST /api/tree/:kind/place. Absent from a brain before it. */
  treeCustomOrder?: boolean;
};

export type Shell = {
  role: ShellRole;
  /** The login at the keyboard (the actor), never the anchor account. */
  loginId: string;
  /** Whether this login is the brain's owner (its anchor login): only the
   *  owner's app deletes are purged after 30 days; anyone else's stay in the
   *  trash until the owner deletes them for good (W6b fix round 2). */
  isOwner: boolean;
  /** Always true for a member or a client: onboarding is an admin's. */
  onboarded: boolean;
  features: ShellFeatures;
  /** The generated avatar, from the login's own seed; null = initials. */
  avatar: { style: string; seed: string; parts: unknown } | null;
  /** The uploaded profile photo's cache-buster; null = none. */
  avatarPhotoVersion: string | null;
  /** Items waiting for the admin's approval. Always 0 for a member or a client. */
  pendingApprovals: number;
  /** The login's live workspaces (the switcher). */
  workspaces: ShellWorkspace[];
  /** The Admin areas the login holds. Always [] for a member or a client. */
  areas: WorkspaceArea[];
  /** Append as `?at=` to byte srcs an <img> cannot send a bearer with.
   *  Absent when it could not be minted. */
  assetToken?: string;
  /** The streamed upload cap, in bytes. */
  maxUploadBytes: number;
  displayName: string | null;
  email: string | null;
  /** The login's starred screens. [] when none. */
  navFavorites: string[];
  /** The kinds served as the item tree: the admin tree (/api/tree/:kind) for
   *  an admin, the reader tree for a member or a client. */
  treeKinds: TreeKind[];
  siteName: string | null;
  peerName: string | null;
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

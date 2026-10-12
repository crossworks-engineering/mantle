/**
 * Apps for members (member logins Phase 4b): what a MEMBER login's client
 * reads from /api/member/apps and /api/member/home, plus the admin's view of
 * member chats (/api/team-admin/member-chats). A member RUNS the brain apps
 * a workspace of theirs holds, with a green published build (its own apps
 * are the my-apps routes). A CLIENT login runs apps at client level only (client logins
 * C6, /api/client/apps).
 */
import type { AppDataAccess, AppTint } from '../app-nav';

/** One launcher card (GET /api/member/apps). */
export type MemberAppCard = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  description: string | null;
  updatedAt: string;
  /** The member only reads this app's data: no workspace of theirs holds it
   *  with Write on, or an admin marked it informational. Off, the member
   *  runs AND writes it. A write to a read-only app answers 403
   *  `{ ok: false, error, reason: 'read-only' }`. */
  dataReadOnly?: boolean;
  /** The same, as the R and R/W pill shows it (team apps Phase 3). Absent
   *  from an older brain: show no pill. */
  dataAccess?: AppDataAccess;
};

/**
 * One folder of the Apps launcher as a member or a client sees it (GET
 * /api/member/apps, /api/client/apps): read only. A folder is listed only
 * when it holds, at any depth, an app of the same answer's `apps`; a folder
 * with nothing the reader may run is absent, name and all. No level, share
 * or system flag.
 */
export type AppLauncherFolder = {
  id: string;
  name: string;
  icon: string | null;
  color: AppTint | null;
  /** The folder it sits in (always one of the same list), null at the top
   *  level. */
  parentId: string | null;
  /** The apps directly in it, in the order of `apps`. An app no folder
   *  names is at the top level. */
  appIds: string[];
};

/** GET /api/member/apps: the apps a member may run, by title, and the
 *  brain's home app when a member may run it (else null). `folders`: where
 *  those apps sit, siblings in the admin's order (0.232.368 on; absent from
 *  an older brain: show the apps as one flat list). */
export type MemberAppList = {
  apps: MemberAppCard[];
  homeAppId: string | null;
  folders?: AppLauncherFolder[];
};

/** The brain's pinned home app, when a member may run it. */
export type MemberHomeApp = {
  appId: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
};

/**
 * GET /api/member/home: the pinned home app (null = the built-in home, and
 * then `hub` is null too) and what its `host.hub.get()` answers. A section's
 * token is a page id; an app card's token is an app id.
 *
 * `THub` is the hub payload, `HubData` from
 * `@mantle/share-ui/app-bridge-protocol`. The contract leaves it to the
 * client (share-ui depends on this package, so it cannot be named here):
 * write `MemberHomeData<HubData>`.
 */
export type MemberHomeData<THub = unknown> =
  { homeApp: MemberHomeApp; hub: THub } | { homeApp: null; hub: null };

/**
 * GET /api/home?ws=<id>: the landing page of a workspace, for every login
 * (task d78e7bde). Without `ws` it is "All my workspaces": the Built-in
 * home over every workspace of the login, never a home app.
 *
 * `ws` echoes the workspace asked for (null: all). `homeApp` is the
 * workspace's home app when the workspace still holds it, its published
 * build is green and the login may run it; null means the Built-in home.
 * `hub` is always there: the data of the Built-in home and what a home
 * app's `host.hub.get()` answers, read in the login's scope and kept to
 * what the workspace reads (sections are its newest pages, counts its items
 * per kind, apps the other apps it holds that the login may run). A
 * workspace the login may not name is 404 `{ error, code: 'not_found' }`.
 *
 * `THub` is `HubData` from `@mantle/share-ui/app-bridge-protocol` (see
 * MemberHomeData).
 */
export type WorkspaceHomeData<THub = unknown> = {
  ws: string | null;
  homeApp: MemberHomeApp | null;
  hub: THub;
};

// ── Admin: member chats ──────────────────────────────────────────────────

/** GET /api/team-admin/member-chats: one member login and its chat. */
export type MemberChatRow = {
  loginId: string;
  /** Display name, else the part of the email before the @. */
  name: string;
  email: string;
  /** False when the login is disabled or no longer a member (its old
   *  thread still shows). */
  active: boolean;
  /** The login's role, named (0.232.333 on): 'member' for the team; absent
   *  for a former member who is an admin now (its old thread still shows).
   *  (No login is a client since workspaces W8a.) */
  role?: 'member';
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
};

/** One message of a member's thread, as the admin reads it. */
export type MemberChatArchiveMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
  traceId: string | null;
  createdAt: string;
};

/** The selected login's OLD team portal chat (member logins Phase 6): the
 *  thread its contact had with the team code before the invite made it a
 *  login. History only, for the admin: never part of the member's live
 *  thread, never shown to the member, never in the agent's context. Show it
 *  apart from `thread`, labelled as the portal history. */
export type MemberChatPortalThread = {
  /** The contact the login was invited from. */
  contactId: string;
  /** A window, ascending; `portalBefore` pages older. */
  thread: MemberChatArchiveMessage[];
  windowSize: number;
};

/** GET /api/team-admin/member-chats?login=&before=&portalBefore= : every
 *  member login, and a window of the selected login's thread (null when
 *  there is no login). */
export type MemberChatsResponse = {
  members: MemberChatRow[];
  selected: {
    loginId: string;
    thread: MemberChatArchiveMessage[];
    windowSize: number;
    /** The login's old portal chat, separate from `thread`. Null (or absent,
     *  from an older brain) when the login has no contact or the contact
     *  never chatted on the portal. */
    portalThread?: MemberChatPortalThread | null;
  } | null;
};

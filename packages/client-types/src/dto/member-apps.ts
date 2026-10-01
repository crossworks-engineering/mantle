/**
 * Apps for members (member logins Phase 4b): what a MEMBER login's client
 * reads from /api/member/apps and /api/member/home, plus the admin's view of
 * member chats (/api/team-admin/member-chats). A member RUNS apps at team
 * level or lower with a green published build; it never creates, edits or
 * shares one. A CLIENT login runs apps at client level only (client logins
 * C6, /api/client/apps).
 */
import type { AppTint } from '../app-nav';
import type { AccessLevel } from './access';

/** The app levels a member may run: team and below (never admin). */
export type MemberAppLevel = Exclude<AccessLevel, 'admin'>;

/** One launcher card (GET /api/member/apps). */
export type MemberAppCard = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  description: string | null;
  audience: MemberAppLevel;
  updatedAt: string;
  /** The member only reads this app's data (client logins C6): true for a
   *  public app, and for an app an admin marked informational. Off, the
   *  member runs AND writes it (team and client apps). A write to a read-only
   *  app answers 403 `{ ok: false, error, reason: 'read-only' }`. Absent from
   *  an older brain: read as `audience !== 'team'`. */
  dataReadOnly?: boolean;
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

/** One launcher card of a CLIENT login (client logins C6, GET
 *  /api/client/apps): an app at client level with a green published build.
 *  No level and no author. `dataReadOnly`: the app is informational, and a
 *  write answers 403 `{ ok: false, error, reason: 'read-only' }`. */
export type ClientAppCard = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  description: string | null;
  updatedAt: string;
  dataReadOnly: boolean;
};

/** GET /api/client/apps: the apps a client may run, by title. The run routes
 *  are the member routes' twins under `/api/client/apps/:id` (frame-ticket,
 *  frame, tool-broker, db-broker), so the sandbox takes that as its API
 *  base. */
export type ClientAppList = {
  apps: ClientAppCard[];
  /** Where those apps sit (0.232.368 on; absent from an older brain). */
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

// ── Admin: member chats ──────────────────────────────────────────────────

/** GET /api/team-admin/member-chats: one member login and its chat. */
export type MemberChatRow = {
  loginId: string;
  /** Display name, else the part of the email before the @. */
  name: string;
  email: string;
  /** False when the login is disabled or no longer a member (its old
   *  thread still shows). Always false for a client: a client is never a
   *  team member (client logins audit B26). */
  active: boolean;
  /** The login's role, named (0.232.333 on): 'member' for the team; 'client'
   *  for a client login with a chat thread, which is NOT a team member; absent
   *  for a former member who is an admin now (its old thread still shows). */
  role?: 'member' | 'client';
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

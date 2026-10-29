/**
 * People (docs/messenger.md, "People"): what a person shares
 * with its team, under /api/people/*. Every login is approved by hand, so a
 * person's card (its name, description, avatar, photo and presence; later a
 * status) is
 * open to the logins that may see it, and to nobody else: itself, the
 * people sharing a live workspace with it (an Admin user sees every usable
 * login), and the people of its chats. A login the caller may not see and a
 * login that does not exist answer the same (a 404, or left out of a list).
 */

/** The avatar a login chose in Appearance, drawn in the brain's one style:
 *  the shape GET /api/shell gives as `avatar` for the caller's own (the
 *  messenger's MessengerAvatar). */
export type PersonAvatar = { style: string; seed: string; parts: unknown };

/** Where a person is. This step sends 'online' (its stream beat in the last
 *  two minutes) or 'offline'; 'idle' and 'busy' come later, so a client
 *  handles every member of the union. */
export type PersonPresenceState = 'online' | 'idle' | 'busy' | 'offline';

export type PersonPresence = {
  state: PersonPresenceState;
  /** ISO: when its stream last beat; null when it never did. */
  lastActiveAt: string | null;
};

/** A status the person set ("in a meeting"), with when it ends. */
export type PersonStatus = { text: string; until: string | null };

/** One person as the team sees it. */
export type PersonCard = {
  /** The login id. */
  id: string;
  name: string;
  /** Who the person is to the team: a job title, a role or a relationship
   *  ("Developer", "Jason's wife"), as they or an admin wrote it. null: none
   *  set. Agents read the same text (messenger_directory). */
  description: string | null;
  /** null: the client draws initials. */
  avatar: PersonAvatar | null;
  /** The uploaded photo's version, the `v` of GET /api/people/:id/photo?v=
   *  (what the shell's `avatarPhotoVersion` is for the caller). null: no
   *  photo. The photo outranks the avatar. */
  photoVersion: string | null;
  presence: PersonPresence;
  /** Not stored yet: always null in this step. */
  status: PersonStatus | null;
};

/** GET /api/people: every person the caller may see, itself included, by
 *  name. */
export type PeopleListResponse = { people: PersonCard[] };

/** GET /api/people/:id. */
export type PersonResponse = { person: PersonCard };

/** One entry of GET /api/people/presence?ids=a,b,c (the cheap poll). */
export type PersonPresenceEntry = { id: string } & PersonPresence;

/** GET /api/people/presence: only the ids the caller may see (at most 200
 *  asked; the rest of a longer list is not read). */
export type PeoplePresenceResponse = { presence: PersonPresenceEntry[] };

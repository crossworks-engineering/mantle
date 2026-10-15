/**
 * Who runs a mini app (app identity, 2026-10-02): what `host.me()` answers
 * inside the app, and what the server fills into the reserved SQL parameters
 * `:host_me_id`, `:host_me_name` and `:host_me_kind`. Docs:
 * docs/app-authoring-guide.md, "Who is running the app".
 *
 * There is no email field, by design: an app is code the admin may not have
 * written. `id` is a per-app pseudonym (the same person has a different id in
 * every app), so an app cannot join a person across apps.
 */

import type { LoginRole } from './role-names';

/** The kind of viewer: a login (its role: the owner or an admin login, a
 *  member login), a Contact share's contact, or an open /s link (no person).
 *  `client` stays for the wire contract (additive only): a client login was
 *  a viewer kind until workspaces W8a removed the role, and an app may still
 *  test `:host_me_kind` for it. No brain answers it now. */
export type AppViewerKind = LoginRole | 'client' | 'contact' | 'public';

export type AppViewer = {
  /** Stable for this person inside this app only; null on an open link. */
  id: string | null;
  /** The display name, for display; null when none is set, and on an open
   *  link. Never use it for permission logic. */
  name: string | null;
  kind: AppViewerKind;
};

/** The viewer on an open /s link: nobody in particular. */
export const PUBLIC_APP_VIEWER: AppViewer = Object.freeze({
  id: null,
  name: null,
  kind: 'public',
}) as AppViewer;

/** Every SQL parameter name with this prefix (any case, after the `:`, `@` or
 *  `$`) is the server's: an app may use the three below in its SQL, and a
 *  value the browser sends for any such name is refused. */
export const APP_VIEWER_PARAM_PREFIX = 'host_me_';

/** The reserved parameter names (without the prefix character) and the
 *  AppViewer field each one is filled from. */
export const APP_VIEWER_PARAMS = {
  host_me_id: 'id',
  host_me_name: 'name',
  host_me_kind: 'kind',
} as const satisfies Record<string, keyof AppViewer>;

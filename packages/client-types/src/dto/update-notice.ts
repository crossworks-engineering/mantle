/**
 * The update notice: the "Update In Progress" screen every signed-in login on
 * a box sees while an update runs. An admin (or an agent, over MCP too)
 * switches it on and off with update_notice_on / update_notice_off; the box
 * also counts as updating while its own updater pulls or rolls a release.
 * The rule that decides it is updateNoticeOn (../update-notice.ts).
 */

/** What an "on" stores, a brain preference (`updateNotice`): when, and on
 *  which version. `null` is the write that switches it off. */
export type StoredUpdateNotice = {
  /** When it was switched on (ISO). */
  setAt: string;
  /** The APP_VERSION the box ran then: on another version it counts as off. */
  version: string;
};

/** GET /api/update-notice: public, so the sign-in page shows it too. One
 *  boolean and the build version, which /api/version already tells anyone. */
export type UpdateNoticeView = {
  on: boolean;
  version: string;
};

/**
 * The runtime's fixed agent slugs, as data only:
 * a leaf module with no imports, so a data module that names them (the
 * system manifest's reconcile helpers) reads them without loading the
 * assistant runtime. The assistant runtime re-exports them
 * (run-team-turn.ts).
 */

/** The agent the manifest ships for the team surface. Since workspaces W5c a
 *  member chats with whichever assistant a workspace of theirs holds (this
 *  one on the Team workspace of a brain switched before 0286, unless an
 *  admin chose another); the slug still names it for the MCP login surface
 *  and the turn-input tools. */
export const TEAM_RESPONDER_SLUG = 'team-responder';

/** The agent that served a CLIENT login's chat (client logins C4). Client
 *  chat went in workspaces W5c; the slug stays for the MCP login surface. */
export const CLIENT_RESPONDER_SLUG = 'client-responder';

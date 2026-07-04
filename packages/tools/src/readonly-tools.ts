/**
 * What an ANONYMOUS visitor to a PUBLIC app share may do through the tool
 * broker: NOTHING.
 *
 * The whole Mantle brain is the owner's private data, and the read tools reach
 * ALL of it by content — search_chunks returns raw passage text from any node
 * (emails, journal, files), search_nodes filters by type incl 'email'/'contact',
 * read_section/file_read pull whole nodes by id. There is no per-node "public"
 * flag to scope against, so there is no such thing as a "public-safe" brain
 * read: a public share that could call any of them is an exfiltration channel
 * for the owner's mail/contacts/journal.
 *
 * So public mode grants ZERO brain tools. A public app is limited to its own
 * per-app SQLite (query-only via the /s/ db-broker) — data the owner put THERE
 * for the app, not the brain at large. Anything that needs a brain tool must be
 * shared in TEAM mode, where the visitor is an identified, audited team member.
 *
 * (Kept as a function, not a bare `false`, so the call sites read intentionally
 * and a future per-node-visibility model has one obvious place to grow.)
 */
export function isPublicToolAllowed(): boolean {
  return false;
}

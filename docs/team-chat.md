# Team Chat (replaced by workspaces)

The team-code portal and its chat are gone (member logins Phase 6), and so
is the member chat that followed it (workspaces W7c). Every user now
chats with the assistant of each workspace they are in, in a thread only
they read. No Admin user reads another user's chat, the owner included.
Read [workspaces.md](./workspaces.md), "Assistants and chats", and
[conversation.md](./conversation.md) section 6d.

What is left of the old team chat:

- `/api/member/chat` and `/api/team-admin/member-chats` answer 410
  `{ error, code: 'gone' }`. A member's thread is read and written through
  `/api/assistant/*`, like every user's.
- `team_messages` was folded into `assistant_messages` (migration 0269) and
  frozen. The old portal rows (a contact's, with no login) are history in
  `archive_team_messages`. Nobody reads them in the app.
- The tools `team_chat_list`, `team_chat_read` and `team_access_list` are
  retired (W7b).
- `/team`, anything under it and `/hub` redirect to `/login`. The old team
  codes and the team-chat credential open nothing.

## Email and journal stay private

The Team workspace's assistant does not read the owner's mail or journal
unless an Admin user switches on **Expose email & journal** (profile pref
`teamPrivateReads`, default off) in Team admin > Settings. The switch is
read at tool resolution and on every read path (`teamHiddenNodeTypes`):
off, the `email_*` and `journal_*` tools are not resolved, and those node
types are hidden from search, passages, node reads and the turn's
retrieval. Secrets, Telegram messages, saved places and peers are hidden
from such a turn always. A surface with no flag fails closed.

The record of how the portal chat worked is in the repository history
before workspaces W8f.

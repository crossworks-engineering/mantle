# Microsoft 365 through the Sync service

Since Sync plan M3 (page f11288e3 in the dev brain) the Sync sidecar
(`server/sync`) connects Microsoft 365 accounts. The brain holds no Microsoft
code: it stores what the sidecar hands it, as for IMAP mail
(`docs/email-ingest.md`) and calendar feeds (`docs/calendar-ingest.md`). The
service itself, its switch and its token are in `docs/services.md` ("Sync").

## The app and the sign-in

- An admin registers a web app in Microsoft Entra and sets it in
  Settings > Accounts (or `sync_microsoft_app_set`): client ID, client
  secret, tenant (`common`, `organizations` or a tenant id) and the redirect
  URI, `<the box's address>/api/microsoft/oauth/callback`. Delegated Graph
  rights: `offline_access openid profile Files.Read.All Sites.Read.All
Mail.Read Mail.Send Calendars.Read`.
- The sign-in is the sidecar's (`server/sync/src/microsoft.ts`):
  authorization code with PKCE and the client secret. Its state and verifier
  live 10 minutes in `service_state`, used once.
- The brain opens the door both ways (`server/web/lib/sync-oauth.ts`):
  `GET /api/services/sync/oauth/start?t=<screen ticket>` checks the ticket
  and its login's `connectors` area, sets a short cookie with the state and
  sends the browser to Microsoft. The callback
  (`/api/microsoft/oauth/callback`, or `/api/services/sync/oauth/callback`)
  needs the state to equal that cookie, then the sidecar finishes it. The
  old callback path stays, so an app registered before M4 needs no change.
- Tokens live sealed in `service_state` (`msaccount:<id>`). The sidecar
  refreshes an access token 10 minutes before its end, one refresh at a time
  per account, and never sends `scope` on a refresh (AADSTS65001).
- Connecting stays a person's act: the consent is in their own browser. No
  tool signs in; `sync_status` says where a person connects.

## Files (OneDrive and SharePoint)

- Discovery: the account's OneDrive (`/me/drive`) and the libraries of its
  followed SharePoint sites (`/me/followedSites`, `/sites/{id}/drives`). A
  new drive starts off.
- A drive run (`server/sync/src/files.ts`), every 5 minutes for a drive
  that is on:
  1. `rclone lsjson -R --hash --files-only` lists the drive, read line by
     line. The backend and a fresh access token go in by environment
     (`RCLONE_CONFIG_MS_*`), never on the command line; no rclone config
     and no rclone daemon.
  2. The list is compared with the brain's file map, `sync_items` (0382):
     service, source (the drive), item id, node, provider hash, size.
     The same id and hash: nothing to do. An id from the copied old map (no
     hash yet) with the same size: re-linked (`POST
/api/sidecar/files/relink`), no download. Anything else is fetched.
  3. Each fetch is one `rclone cat`, its bytes streamed straight into
     `POST /api/sidecar/files`. The brain spools it to disk with its sha256,
     refuses a file cut short, and makes an ordinary `file` node: one per
     owner and sha256 (among the nodes a drive sync made), bytes in the
     object store, flat under `<account branch>.<drive label>`. A changed
     file's old node is retired when no other row holds it.
  4. Only after a listing that ran to its end: each item gone from the
     drive, or out of its selections, leaves the map, and its node when no
     other row holds it (`POST /api/sidecar/files/remove`). A node a person
     uploaded, an attachment or a drawing holds is never removed.
- A file over 64 MB (the buffered upload cap) is skipped and counted.
- Selections: none chosen is the whole drive; a folder holds its path and
  everything below; a file matches by id or path.
- Switching a drive off keeps its files and its map. Disconnecting an
  account drops its maps (`POST /api/sidecar/files/forget`); every file
  stays.

## Outlook mail and send

- The mail switch makes (or switches on) one `email_accounts` row with
  provider `microsoft` and no credential, under `<account branch>.mail`.
- Every 5 minutes the inbox is read from a `receivedDateTime` watermark
  (`server/sync/src/outlook.ts`), a page at a time: the envelopes go through
  the brain's one gate (`/api/sidecar/mail/gate`), and only the wanted
  messages are fetched in full and stored (`/api/sidecar/mail/ingest`), as
  for IMAP. Backfill and discover read the inbox too.
- Send: `email_send` and `email_page` reach the sidecar's `/send`. When the
  sender is a Microsoft account with its mail on and `Mail.Send` granted
  (or no IMAP mailbox sends), it goes out through Graph `/me/sendMail`:
  attachments at most 2.5 MB in all, no In-Reply-To (Graph takes only `x-`
  headers).

## Moving a box from before M4

Turn Sync on, then run the maintenance task `sync-copy-accounts` (dry run
first). It copies the Microsoft app (`microsoft_config`, else the `MS_*`
environment), each account with its tokens and its mail switch, each drive
with its chosen folders, and each `ms_drive_items` row into `sync_items`,
under the same ids. The old tables stay until a later release drops them.

# Control Center: the fleet user ban

A Control Center (CC) is one Mantle box that can ban a person on every box
it manages at once. An organisation runs one CC for its own boxes. It is a
standard part of Mantle and works without any identity provider.

Phase 1 is the fleet user ban only. The CC can:

- read a short login list of each box (ids, emails, flags, company sign-in ids);
- disable logins;
- enable again only the logins the CC itself disabled;
- archive logins (a permanent disable).

It can never create or delete a login, set a password, make a key, read
data, or touch the box's original account (the owner).

## How it fits together

```
CC brain (Fleet screen, control_* tools)     writes bans and box rows
        |
control service (CC only, holds the key)     reads them every few seconds
        |  POST /api/control/call, signed with Ed25519
        v
each subject box                             checks the signature, runs one of 6 cases
```

- The **brain** on the CC keeps the box list and the bans
  (`control_boxes`, `control_bans`, `control_results`, migration 0364). It
  never signs anything.
- The **control service** (`worker_control`, compose profile `control`)
  runs on the CC only. It makes its key pair on first start in
  `${MANTLE_DATA_DIR}/control-key`. No other app service mounts that
  folder (only `objectstore_init`, a fixed script, mounts the whole data
  folder), and no scheduled backup holds it. A disk snapshot of the data
  folder does: keep those safe, or move the folder. It writes only the
  public key to the database (`control_service`, again every tick) and
  logs its fingerprint.
- A **subject box** has two `.env` lines. Only `.env` makes a box a
  subject: no screen, route or tool sets them.

### CC code loads on a CC only

Owner decision B (2026-11-09): what only a CC needs is never loaded
elsewhere. The one check is `MANTLE_IS_CONTROL_CENTER`
(`isControlCenter()`, `server/web/lib/control/env.ts`); each place asks it,
then imports the CC code lazily:

- SCIM ([scim.md](scim.md)): every `/scim/v2` route and the setup screen's
  SCIM-token route answer the plain 404 off a CC; `GET /api/users/scim`
  answers `{ on: false }`; the token hash, a screen token and
  `MANTLE_SCIM_AUTO_LINK` count for nothing.
- The Fleet routes answer 404 before they load `lib/control/fleet.ts` or
  the CC store (`@mantle/db/control-center`, not in the `@mantle/db` index).
- The `control_*` tools are registered on a CC only (`@mantle/tools`
  `registry.ts`), and the manifest's `control` group exists there only.
- The control service idles: it loads no key, no run, no store.

A CC that turns its flag off keeps its `control` tool group row and the
seven tool rows; their calls fail at dispatch. Disable the group then.

The box side stays on every box: `POST /api/control/call` and
`lib/control/{box,sign,env}.ts`. `server/web/lib/control/cc-only.test.ts`
pins this, with a scan that no other module imports CC code at top level.

## Set it up

On the CC:

```sh
# .env
MANTLE_IS_CONTROL_CENTER=on
COMPOSE_PROFILES=...,control
docker compose up -d
```

Open Admin > Fleet. It shows the CC's public key, its fingerprint (check it
against the `control key fingerprint` line in the `mantle_worker_control`
log) and the two lines to copy.

On each box the CC manages, add the two lines and restart:

```sh
# .env
MANTLE_CONTROL_CENTER=https://cc.example.com
MANTLE_CONTROL_CENTER_KEY=ed25519:BASE64
docker compose up -d
```

The box logs one line at boot: `this box is managed by the Control Center
at ...`, or `Control Center link off:` and the reason. The box needs
`MANTLE_PUBLIC_URL` set: the CC signs that origin. A CC is never a subject.

Then, at the CC, add the box by its URL (Admin > Fleet, or
`control_box_add`). The first run starts at once. The box shows no reason
code once it answers.

Before you link a box, check that the CC reaches it over HTTPS directly.
The CC calls the boxes; a box never calls the CC.

## The signed call

`POST /api/control/call`, body `{ "op": ..., "args": ... }`. The CC signs:

```
mantle-control-v1\nPOST\n/api/control/call\n<box origin>\n<unix seconds>\n<sha256 hex of the raw body>
```

and sends `x-mantle-control-time` and `x-mantle-control-signature`.

The box makes two checks, and no third:

1. **The signature.** The box is a subject; the body is at most 64 KB; the
   time is within 60 seconds either way; the key in its `.env` signed its
   own origin (from `MANTLE_PUBLIC_URL`, never a request header) over the
   raw bytes. Only then is the JSON read. A refusal answers a reason code
   only: `time`, `sig`, `size`, `bad-call`. A box with no lines answers 404.
2. **The fixed switch.** Six cases: `hello`, `logins`, `disable`,
   `enable`, `archive`, `key`. They are not tools. No agent, MCP client or API key
   on the box reaches them.

`disable`, `enable` and `archive` take `{ loginIds }` only and run the
Users screen's own change with the actor `control-center`. Every way in
ends at once: cookies, device and phone bearers, API keys, MCP grants,
pairing codes, push devices. The box writes an audit row for each call.
Rows that store an actor id (revoked keys, unbound peers) name the box
owner's id, as SCIM's do.

A replay within 60 seconds at the same box mostly changes nothing:
`hello` and `logins` are reads, and the writes are idempotent. One case
does: a lift's `enable`, replayed within its 60 seconds after a new ban's
`disable` of the same login, enables that login again until the next run
(within 5 minutes). It needs the TLS traffic first (for example a
TLS-inspecting proxy between the CC and the box). Accepted: a nonce would
be a third check. A call signed for one box fails at another.

## The kill switch

For each box due a run, the control service:

1. asks `logins`;
2. matches the bans at the CC (the box never sees the ban list);
3. sends `archive`, `disable` and `enable` with login ids.

A box is due at once after a ban, a lift or an add, and every 5 minutes.
Eight boxes run at a time. The repeat covers a box that was down, a login
made after the ban, and a box restored from an old backup.

Outbound: https only, no redirect followed, 10 seconds per call, a 4 MB
reply cap, certificate checks on.

No box asks the CC at sign-in. A CC outage locks nobody out and lets
nobody back in. Disables already done stay.

### How a person is matched

A login matches a ban when ANY key matches:

- **email**: the login's email, lowercase, equals a ban email, lowercase;
- **company sign-in id** (optional, any provider): a company sign-in link
  on the login has the ban's issuer and object id.

An alias or a `+tag` address does not match: a box Admin disables that by
hand. Before you make a ban, the Fleet screen (or `control_ban` with
`preview: true`) shows its matches on each box, from each box's last login
list.

### The box owner

The original account is never disabled. A ban that matches it is shown in
red: "the owner of this box matched a ban and stays live". Keep each box
owner a break-glass account, not a person's daily login.

## Lift a ban

A disable ban can be lifted at the CC (owner decision: the CC may undo its
own bans). When the box disables a login it keeps a marker: the
`disabled_at` it set (`control_disables`). The next run sends `enable` for
the logins the lifted ban matches that no active ban matches. The box
enables a login only while its marker still equals its `disabled_at`. So
the CC never enables a login a box Admin disabled by hand, or one disabled
again by hand after the CC. To keep a CC-disabled login off after a lift, a
box Admin presses Disable again on the Users screen: the users area's own
disable writes a new `disabled_at`, so the marker no longer matches.

Enabling restores sign-in only. Keys, MCP grants and devices the disable
ended stay gone.

A box Admin who enables a banned person by hand is disabled again at the
next run, until the ban is lifted.

## Archive (permanent disable)

A ban of kind `archive` (made on the Fleet screen, or with `control_ban`
and `archive: true`, which is a person's act: an agent may send only
`archive: false`, `packages/tools/src/person-only-acts.ts`):

- disables the login (a new `disabled_at`), sets `auth.users.archived_at`,
  and drops the CC's marker;
- deletes nothing: what the login wrote keeps its author, the audit log
  keeps its rows;
- keeps the email: no new login on that box can use it.

Only a box Admin undoes it, by hand: Enable on the Users screen clears
both. The CC cannot: with no marker its enable is refused, and lifting an
archive ban only retires it (its runs stop). SCIM cannot either: the new
`disabled_at` no longer matches SCIM's own. While the CC holds an active
archive ban, a hand restore is archived again at the next run.

To give the address to a new person on that box, a box Admin restores the
archived login or deletes it by hand.

## Set a provider key on the fleet

A CC Admin sets or replaces one provider key (for example `openrouter`) on
every linked box, or on the boxes they pick: the Fleet screen, or
`control_key_set` (`POST /api/fleet/keys`).

- The CC seals the key for each box (the master key, AAD the box id) in the
  box's row (`control_boxes.key_job`, migration 0365) and asks for its run at
  once. The control service sends it in the signed `key` case and clears
  the job whatever the box answers. A job older than an hour is deleted
  unsent at the service's next tick, and the box row says `expired`. So
  the CC holds a sealed key until it is sent (seconds), at most an hour
  while the service runs, or until its first tick back if it was down. It
  never shows or logs it, and no answer holds it.
- The box takes the service only from its own fixed list (an AI provider,
  or a key service its Keys screen knows), sets the key through its vault's
  own gateway as the Keys screen does (sealed, an audit row), and tests it.
- The answer is ok, or one reason: `service` (not on that box's list,
  nothing set), `refused` (the vault said no, or the name holds a password,
  a login or an SSH key, which is never overwritten; nothing set), `untested` (set, the service has no test), or
  `failed` (the provider refused the new key or could not be reached: the
  box is put back exactly as it was, its old key or no row at all, so a
  wrong key stops no box). A box that does
  not answer gets a reason code (`unreachable`, `off`, ...) and keeps its key.
- The box row keeps the last answer (`keyResult`: service, ok or the reason,
  who, when), shown on the Fleet screen and in `control_box_list`. A box that
  failed is sent the key again by a new request.

## Unlink

- From the box (the box owner always wins): remove the two lines, then
  `docker compose up -d`. Every control call is refused at once.
- From the CC: remove the box (Fleet, or `control_box_remove`). All calls
  to it stop.

## Key loss or rotation

Stop `worker_control`, move `${MANTLE_DATA_DIR}/control-key/ed25519.pem`
away, start it. It makes a new pair. Set the new public key line on every
box (one ssh loop with your roll tooling).

## The Fleet area and tools

Admin only (the settings area). On a box that is not a CC every Fleet route
answers 404 and no `control_*` tool exists.

| Route                           | Tool                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `GET /api/fleet`                | `control_box_list`, `control_ban_list`, `control_public_key` |
| `POST /api/fleet/boxes`         | `control_box_add`                                            |
| `DELETE /api/fleet/boxes/:id`   | `control_box_remove`                                         |
| `POST /api/fleet/bans`          | `control_ban` (with `preview: true` first)                   |
| `POST /api/fleet/bans/:id/lift` | `control_ban_lift`                                           |
| `POST /api/fleet/keys`          | `control_key_set`                                            |

The writes are `peerRisky`: an API key must name them. No shipped agent
holds the `control` tool group.

Box reason codes on the Fleet screen: `off` (the box has no control lines),
`time` (clock skew), `sig` (the box holds another key), `unreachable`,
`http-NNN`, `bad-reply`, `reply-too-large`.

## Accepted risks

- A banned person redeems a pending invite on a box: the new login has the
  same email and is disabled at the next run (within 5 minutes).
- A replay of a signed call within 60 seconds at the same box: harmless
  but for a lift's enable replayed after a new ban (see "The signed
  call"), and it needs the TLS traffic first.
- The CC restored from an older backup loses later bans; disables already
  done stay.
- Anyone who takes the CC can disable logins fleet-wide and lift the CC's
  own bans (owner decision). It still cannot take over a box: no login,
  key, role or data.
- Peers a banned Admin made that act as a member, and share links, stay
  live after the disable (only peers bound to the login itself end). The
  leaver report lists them.

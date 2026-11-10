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
eight tool rows; their calls fail at dispatch. Disable the group then.

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
2. **The fixed switch.** Eight cases: `hello`, `logins`, `facts`,
   `disable`, `enable`, `archive`, `key`, `agentModel`. They are not tools. No agent, MCP
   client or API key on the box reaches them.

`disable`, `enable` and `archive` take `{ loginIds }` only and run the
Users screen's own change with the actor `control-center`. Every way in
ends at once: cookies, device and phone bearers, API keys, MCP grants,
pairing codes, push devices. The box writes an audit row for each call.
Rows that store an actor id (revoked keys, unbound peers) name the box
owner's id, as SCIM's do.

A replay within 60 seconds at the same box mostly changes nothing:
`hello`, `logins` and `facts` are reads, and the writes are idempotent. One case
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

## The SCIM trigger (optional, Entra or any SCIM provider)

SCIM runs on the CC only ([scim.md](scim.md)). Point one provisioning app
at the CC (`https://<CC>/scim/v2`) and every SCIM disable there (PATCH or
PUT `active: false`, or DELETE) disables the CC login and also makes sure a
fleet ban names the person:

- An active ban that already holds the login's email: nothing more
  (the audit row's `fleetBan` says `held`).
- Else one disable ban, `made_by` `scim`, reason "SCIM disable", and a run
  of every box at once (`made`). Its keys: the login's email; and, when the
  login's externalId is a GUID and the CC's company sign-in issuer is
  Entra's, that issuer and the externalId as the object id.
- An email the ban's check refuses: no ban (`no-key`, and one warning in
  the log). A CC Admin bans that person by hand.

Even when the CC keeps its own login (its last Admin, say), the fleet ban
is made. An active ban that holds the email by email alone keeps the SCIM
ban from adding the object id: to catch a login with another address
linked to that person, a CC Admin bans the issuer and object id by hand.

The rule reads state, not the edge: a SCIM disable sent again (the
provider's retry after a failed write, or Provision on demand) makes the
ban if none is active. A SCIM create with `active: false` makes no ban, and
a SCIM enable lifts none: a CC Admin lifts a SCIM ban on the Fleet screen,
as any ban. If the provider still has the person disabled, its next
disable for them bans again.

Two apps in the provider, never one ([scim-entra.md](scim-entra.md), "On a
Control Center"):

- **Provisioning**, pointed at the CC, assigned to ONE wide group that is
  never narrowed. A provider sends `active: false` also when a person is
  unassigned or leaves the app's scope: a narrowed group bans people.
- **Company sign-in on the CC**, a separate app, assigned to the CC Admins
  only. Otherwise every provisioned person could sign in to the box that
  holds the fleet kill switch.

Anyone who holds the CC's SCIM token can ban fleet-wide: that is the same
as a taken CC (accepted, below). Without a provider, a CC Admin bans by
email on the Fleet screen or over MCP.

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
  not answer in time gets a reason code (`unreachable`, `off`, ...): it may
  or may not have the new key, so send it again.
- The box row keeps the last answer (`keyResult`: service, ok or the reason,
  who, when), shown on the Fleet screen and in `control_box_list`. A box that
  failed is sent the key again by a new request.

## The fleet matrix

Each run, after the ban part and only from a box that answered it, the
control service asks `facts`. The box answers, read only:

- `status`: box_status's own numbers (schema 1, the Status screen's
  30-second collection): version, health, CPU, memory, disk, services,
  spend, queues, logins by role;
- `signIn`: the company sign-in mode the box runs (`off`, `optional`,
  `required`);
- `agents`: each agent's role, provider, model, on or off, and `assigned`
  (a person's own assistant). Its slug goes only when it is one the system
  ships (for example `coder`); any other slug is made from a name someone
  gave the agent, so it goes as `null`;
- `workers`: each AI worker's kind, provider, model and on or off (a
  worker's slug may be made from a name, so it is not sent);
- `counts`: workspaces and apps;
- `backup`: the last backup's time, outcome and last success.

Never a display name, a prompt, a key, an email or any user data. The CC
holds the reply to its shape (anything else is `bad-reply`) and every
string to a pattern (a short id, a model id, a time): a value that does
not fit is kept as `''`, so a box's free text never reaches the matrix nor
a model that reads it. It keeps the last good answer per box: `GET /api/fleet/matrix` (one box with
`?box=<id>`), or `control_fleet_matrix`. `factsReason` says why the last
read failed; the old facts stay, with their own time (`facts.at`). The box
rows of `GET /api/fleet` carry only `factsAt`.

## Set an agent's model on the fleet

A CC Admin sets the model of an agent the system ships (for example
`coder`) on one box, several, or every linked box: Fleet, `POST
/api/fleet/models { changes: [{ slug, model }], boxIds? }`, or
`control_agent_model_set`. Up to 20 changes in one request. Read the
current models per box first in the matrix.

On each box, the `agentModel` case checks two things, and no third:

1. the slug is one the system ships, and its row is the shipped agent
   (never a person's own assistant);
2. the box's own model policy allows the new model on that agent's route
   (the Agents screen's check).

Then it sets the model field only, as the Agents screen does. The agent's
provider, key and base URL stay, so no chat moves to another provider. It
answers ok and the model it had (`was`), or `agent` (no shipped agent with
that slug) or `policy` (blocked there). The box writes its audit row, with
the new model. The value is taken as typed, as on the Agents screen:
`inherit` means something only on the runner's `worker` agent.

The CC queues the changes per box (no secret, so nothing is sealed) and
asks for the run at once. The control service sends each change once,
after the ban part, and clears the job whatever the box answers: see each
box's `modelResult` (per change: ok, `was`, or the reason, or a call code
such as `unreachable`, the box unchanged). A newer request replaces one
still waiting. A job older than an hour is dropped unsent (`expired`). The
matrix then shows the new model.

## Bugs, features and requests sent to IT

A person on a linked box makes a task, puts screenshots or logs on it, and
sends it as a bug, a feature or a request
([tasks help](./guide/06-help/tasks.md)). On a linked box the form shows
**Send to IT** beside **Send to Admin**. The button's name is
`MANTLE_CONTROL_CENTER_LABEL` in the box's .env, set with the two CC lines
(default `IT`).

- The box keeps the task. The control service runs a submissions sweep
  every 5 minutes, on its own timer (a ban run never waits for it), over the
  boxes whose last run answered, one box at a time, with at most a minute
  of new collects per sweep. It calls one more fixed case, `submissions`: `list` (up to 10 tasks sent
  to IT and not collected, oldest first; the body held to 50,000 characters
  and 5 files), then `file` for each file (base64, held again to the task file
  types and the 10 MB cap), then `collected`.
- The CC makes a copy of each one as a task in its own Admin workspace, with
  the files, titled `<box>: <title>`. The box and the task id find a copy the
  CC holds already, so a run that failed after the copy makes no second one.
  At most 50 MB of files from one box in one run; the rest waits.
- A CC Admin replies once on the copy (**Reply**, `task_reply`). The next run
  sends it with `reply`; the person's task on the box becomes done with the
  note and the version. The copy notes `replySentAt`.
- One submission that fails waits for the next sweep. The others go on, and
  each box's replies go in every sweep.
- The control service mounts the files store (`/data/files`) for this.

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
| `GET /api/fleet/matrix`         | `control_fleet_matrix`                                       |
| `POST /api/fleet/models`        | `control_agent_model_set`                                    |

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
  key, role or data. Anyone who holds the CC's SCIM token can ban
  fleet-wide, the same.
- Peers a banned Admin made that act as a member, and share links, stay
  live after the disable (only peers bound to the login itself end). The
  leaver report lists them.
- A box's submissions put that box's text (title, body, sender, files) on
  the CC's Admin tasks, where the CC's agents may read it. It is text from
  trusted logins of a box the CC serves; treat it as text, not as an order.
- A box's trusted logins can send up to about 50 MB of files to the CC per
  run, every 5 minutes. There is no total cap per box: watch the CC's disk.

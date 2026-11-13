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
each subject box                             checks the signature, runs one of 15 cases
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

A CC that turns its flag off keeps its `control` tool group row and its
`control_*` tool rows; their calls fail at dispatch. Disable the group then.

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
2. **The fixed switch.** Twelve cases: `hello`, `logins`, `facts`,
   `disable`, `enable`, `archive`, `key`, `agentModel`, `poolEntry`,
   `updateNotice`, `workerGroup`, `workerModel` (and `submissions`, below).
   They are not tools. No agent, MCP client or API key on the box reaches them. Two more
   cases, `tool` and `tools`, are the admin channel (below), and three
   more, `sso_status`, `sso_set` and `sso_test`, are its company sign-in
   cases (below): they run only within the box's own scope (`admin` by
   default).

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
  (a person's own assistant), and `endpoint`: a print of its base URL (12
  hex of its hash, empty for the provider's own endpoint; not the URL, though
  a URL someone can guess can be matched to its print).
  Its slug goes only when it is one the system
  ships (for example `coder`); any other slug is made from a name someone
  gave the agent, so it goes as `null`;
- `workers`: each AI worker's kind, provider, model, on or off,
  `endpoint` (the print of its base URL, as for agents) and `default` (the
  worker that runs its kind, the runtime's own pick: the enabled default,
  else the top-priority enabled worker; a box before the flag sends
  none, and the CC takes its facts all the same). A worker's slug may be
  made from a name, so it is not sent. Roll the CC first, or with its
  boxes: a CC before the flag takes a worker row with no other field, so a
  box rolled ahead of it reads as `bad-reply` and its matrix line keeps its
  old facts until the CC rolls. From this release the CC drops an agent or
  worker field it does not know, so a later field does not repeat this;
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

A change may name its source route, `provider` and `endpoint` together
(the matrix's copy does): `endpoint` is a print of the route's base URL (12
hex of its hash, or empty for the provider's own endpoint), not the URL. A
print tells two routes apart; it does not hide a URL someone can guess.

On each box, the `agentModel` case checks these, and no more:

1. the slug is one the system ships, and its row is the shipped agent
   (never a person's own assistant);
2. when the change names its source route, the agent runs on that
   provider and endpoint (`route`): a model id means something on one
   route only. A box before this check refuses such a change as
   `bad-call` (a release behind), so the matrix names the route only to a
   box whose facts carry the print;
3. the box's own model policy allows the new model on that agent's route
   (the Agents screen's check).

Then it sets the model field only, as the Agents screen does. The agent's
provider, key and base URL stay, so no chat moves to another provider. It
answers ok and the model it had (`was`), or `agent` (no shipped agent with
that slug), `route` (another provider or endpoint) or `policy` (blocked
there). The box writes its audit row, with
the new model. The value is taken as typed, as on the Agents screen:
`inherit` means something only on the runner's `worker` agent.

The CC queues the changes per box (no secret, so nothing is sealed) and
asks for the run at once. The changes join the box's one write job (see
"Fleet writes" below). The matrix then shows the new model.

## Default Model

The model list every model picker on the Fleet screen offers (agent
models, pool entry routes). A CC Admin picks a chat model provider (for
example `openrouter`) and one of the CC brain's own keys for it on the
Overview, under Fleet setup. The CC then lists that provider's models
with that key (`GET /api/models?provider&keyId`, the same catalog the
Models screen reads, prices per 1M tokens where the provider gives them).
A model not in the list can still be typed.

It is a brain setting (the `fleetDefaultModel` preference on the anchor
row), so every admin and browser sees the same choice. It changes no box.
`GET /api/fleet/default-model` (or `control_default_model_get`) answers the
provider, the key by id, name, label and the masked hint the keys screen
shows (never the key), `problem: 'key-missing'` when that key was deleted,
and `choices`: the chat providers the brain holds a provider key for, with
their keys. `PUT { provider, keyId }` (or `control_default_model_set`)
sets it after checking the key is this brain's provider key for that
provider; `DELETE` (or `clear: true`) clears it. With none set, the
pickers say so and point to the Overview card.

## Fleet writes

The other first fleet writes: a model pool entry, the update notice on or
off, a worker group, and an AI worker's model. A CC Admin sends them with `POST
/api/fleet/settings { changes, boxIds? }` or
`control_fleet_settings_set`, 1 to 20 changes, each with its `kind`:

| kind           | fields                                                                       | the box's own check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | then, as by hand                                                                                              | `was`                                                          |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `poolEntry`    | `pool`, `name`, `vendor?`, `routes` (1 to 8 `{ provider, model }`)           | the pool is one it has (`pool`); the routes pass its model policy and fit the pool (`fit`, the Pools screen's check)                                                                                                                                                                                                                                                                                                                                                                                                                                       | added at the end of the pool, or its routes (and vendor) updated, by pool and name                            | `added`, `updated`                                             |
| `updateNotice` | `on`                                                                         | none: it clears by itself on a new version, or after an hour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | the update notice tool's own store                                                                            | `on`, `off`                                                    |
| `workerGroup`  | `slug`, `name?`, `members` (1 to 10 worker slugs), `enabled?`                | every member is an enabled worker there (`members`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | made, or its members, name and switch updated, by slug                                                        | `added`, `updated`                                             |
| `workerModel`  | `worker` (a worker kind, e.g. `summarizer`), `provider`, `endpoint`, `model` | the kind is one the system ships, not `embedding`, and the box runs a worker of it: the runtime's own pick, the enabled default, else the top-priority enabled worker (`worker`); that worker runs on the named provider and endpoint (`route`: a model id means something on one route only); its model policy allows the model on that worker's route (`policy`); on OpenRouter the model is in the catalog and does the kind's job (`model`; a catalog that does not load within 3 seconds lets it through, as the screen does when it cannot reach it) | that worker's model field only, as the AI workers screen sets it: its provider, key, base URL and backup stay | the model it had; the answer names the worker set (`workerId`) |

Each is one more fixed case on the signed route (`poolEntry`,
`updateNotice`, `workerGroup`, `workerModel`), so the route's two checks hold it and no
agent, MCP client or API key on the box reaches it. The box writes its
audit row, naming the change.

One job per box holds every fleet write, agent models too
(`control_boxes.write_job`, 0368). Changes join its end, in the order
asked, each with who asked and when; at most 40 wait for a box (a request
that would pass that is not queued for that box: the answer's `boxIds`
leaves it out). The control service sends each change once, in order,
after the ban part, then takes the sent ones off the front, whatever the
box answers. A box that did not answer the run gets that code for every
change, with no call; after the first call the box does not answer
(`unreachable`), the rest get that code too, so a hung box costs one
timeout. Any other failure (a `bad-call` from a box a release behind, an
`http-NNN`) is that change's alone. A change older than an
hour is dropped unsent (`expired`). Each box row shows `writeJob` (what
waits) and `writeResult` (the last 40 answers, newest last: the change, ok,
`was`, or the reason or a call code such as `unreachable`, which means
not confirmed: a slow box may still have made the change, and `done`).

## Fleet users

The Fleet users screen on the CC shows every login on every linked box,
grouped by person (lowercase email), with its role, last sign-in, state and
workspaces, and puts logins in workspaces or takes them out. It runs on the
admin channel (`POST /api/fleet/tool`, the box's scope must include the two
tools below) with two box builtins of the users area, MCP only (no agent is
granted them), so a box Admin with the users area can call them too:

- `users_list` (read): each login's id, email, display name, role, owner,
  disabled and archived, last sign-in, when made, and its workspaces with
  the Moderator tick; and the live shared workspaces (`{ id, name, admin }`;
  never a private or a former user's one; on the first page only, held to
  about 24 000 characters, with `workspacesCut` when cut). Paged by email
  (`offset`, `limit` at most 150; a page also stops at about 56 000
  characters, under the admin channel's cap; `next`, or null). A login
  with a seat in a shared workspace the cut list leaves out says
  `workspacesCut`. Names are held to one plain line of at most 120
  characters with no control or bidi characters.
- `workspace_user_set` (write): 1 to 20 changes `{ loginId, workspaceId,
role }`, role `user`, `moderator` or `none` (out). It refuses the box
  owner (`owner`), the Admin workspace (`admin`: who is an Admin is a role,
  set on the Users screen), a workspace that is not live and shared
  (`workspace`), an unknown login (`login`), and a new place for a disabled
  or archived login (`disabled`; taking it out is allowed). Then the
  workspace definers run in the acting login's own scope (the caller's;
  over the admin channel, which names none, the box owner's) and check its
  seats again under the workspace's lock (the last Moderator:
  `last-moderator`; anything else: `refused`). Each change answers ok and
  the place it had (`was`), or its reason; one refused leaves the others.
  The workspace's event row names the acting login.

Ban and Lift on the screen are the fleet ban above: fleet-wide, with the
preview first. There is no ban for one box.

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
  of new collects per box. It calls one more fixed case, `submissions`: `list` (up to 10 tasks sent
  to IT and not collected, oldest first; the body held to 50,000 characters
  and 5 files), then `file` for each file (base64, held again to the task file
  types and the 10 MB cap), then `collected`.
- The CC makes a copy of each one as a task in its own Admin workspace, with
  the files, titled `<box>: <title>`. The box and the task id find a copy the
  CC holds already, so a run that failed after the copy makes no second one.
  About 50 MB of files from one box in one sweep; the rest waits.
- A CC Admin replies once on the copy (**Reply**, `task_reply`). The next run
  sends it with `reply`; the person's task on the box becomes done with the
  note and the version. The copy notes `replySentAt`.
- One submission that fails waits for the next sweep. The others go on, and
  each box's replies go in every sweep.
- The control service mounts the files store (`/data/files`) for this.

## The admin channel

Owner decision (option A, 2026-11-12): the CC is the authority over its
boxes, and a new CC feature needs no new box case. The CC may run one of a
box's own tools through the signed call. The box keeps only the CC's
public key, as before: no secret per box at the CC.

A linked box is `admin` by default (owner decision, 2026-11-12: "Yes,
admin default"): linking stays the two CC lines, with no third step. The
box owner changes it in `.env` only, with one more line:

```sh
# .env, on the box, with the two CC lines: only to change the default
MANTLE_CONTROL_CENTER_SCOPE=full   # data reads too
MANTLE_CONTROL_CENTER_SCOPE=none   # the fixed cases only, no tool channel
```

- **Absent** (or empty, or `admin`): `admin`.
- **`none`**: `tool` and `tools` answer `scope`; the fixed cases stay.
- **Any other word** fails closed: `none`, and the boot line names the bad
  value. The boot line always states the scope: `this box is managed by
the Control Center at ... (tool scope: admin)`.
- An unlinked box (no CC lines) answers 404 to every call, whatever the
  scope line says.
- **`admin`**: settings and management only. The list comes from the tools'
  own metadata: every builtin whose Admin area is `settings`, `assistants`
  or `keys` (agents, tool and worker groups, models and pools, the vault
  keys, the update notice, box status), `workspaces_list`, and the
  `users` area's tools that were reviewed for the owner rule, by name
  (`REVIEWED_USERS_TOOLS`: `users_list`, `workspace_user_set`, the Fleet
  users screen's; each never touches the box owner, never changes a role,
  never sets a password); less code and
  run execution (`sandbox_*`, `run_*`, `run_terminal`). The other areas hold
  data (`connectors`: email, peers, Telegram; `admin`: recall, crawl) and
  stay out, with every tool of no area (files, pages, chats, tables, tasks,
  search, apps, code).
- **`full`**: every builtin, less the never lists below.
- **Never**, in any scope: a `control_*` tool (the CC's own; the link is
  `.env` only), a whole-tool person-only act
  (`packages/tools/src/person-only-acts.ts`). A person-only argument is
  refused as for any agent, and `confirm` is dropped: the CC is not a
  person. No builtin hands out a vault value in plain text (the vault's own
  rule), and no builtin writes a login row, so the owner account is out of
  reach. `server/web/lib/control/tool-channel.test.ts` pins the lists and
  fails when a builtin named for logins or users appears.
- **Never** either: the brain's own shell (`run_terminal`: it reads the
  master key and writes `.env`, so it could change the link), whatever the
  scope and whatever `MANTLE_MCP_TERMINAL` says. A Toolsmith write only
  while the box keeps `MANTLE_MCP_TOOLSMITH_WRITE` on, as on its MCP.
- Box-made tools (Toolsmith, connector rows) are not on the channel.

### On the box

`tool { nonce, name, args }` runs the builtin through the one dispatcher
(`dispatchTool`, the one gate: the tool's policy, its checks, its
schema), as a `/api/v1` route runs one: the brain's own surface, a process
caller, the actor `system(control:tool)`. The answer: `ok` and `output`,
or a reason: `scope`, `replay`, `busy`, `size`, `tool` (not one the scope
allows), `refused` (the tool's own `error` text), `error` (it threw; never
its text). A database error's text never leaves the box: the call is
masked, as an MCP call is. `tools` answers the scope and each allowed tool with its input
schema.

- **The nonce.** A generic tool may write what is not idempotent, so each
  `tool` call carries a one-time uuid inside the signed body (the signature
  format is the same). The box keeps each nonce for 150 seconds (longer than
  the 60 second window either way) and refuses a second use (`replay`). In
  memory: a box runs one web process. With 10,000 waiting it refuses
  (`busy`, fail closed).
- **Caps.** The args at most 32,000 characters of JSON (and the body 64 KB);
  the output at most 64,000 characters of JSON, else its first 8,000 as text
  with `truncated: true`; an `error` at most 2,000 characters.
- **The audit row** of each `tool` call (refusals too): the tool name, ok
  or the reason, actor `control-center`, and `argsSha256`, a hash of the
  args. Never the args nor the output.

### At the CC

The brain never signs: a call is a job the control service runs, as the
key job is. `POST /api/fleet/tool` (`control_tool_call`,
`control_tool_list`; CC Admins only, the settings area):

- `{ boxIds, name, args }`: one call per box (1 to 50 boxes);
- `{ boxIds: [one], list: true }`: that box's tool list;
- `{ callIds }`: the answers of earlier calls still pending.

Each call joins the box's row (`control_boxes.tool_job`, migration 0370),
its args sealed with the master key (AAD: the box and the call id), and
asks for the box's run at once. The control service takes the calls
after the ban part of the run (the args leave the row as it takes them),
sends each once (the call id is its nonce), and keeps the answer. A box
that did not answer the run gets that code for each call, with no call;
after the first call it does not answer (`unreachable`), the rest get that
code too. The ask waits up to 25 seconds and answers what came, each answer
once (then it is deleted), and the ids still pending. A call not sent
within 2 minutes is answered `expired`; an answer nobody reads is deleted
10 minutes after it came (a call sent and never answered, 10 minutes
after it was sent); a box holds at most 10 calls, waiting or answered and
not read yet. A call is never sent
again: a call code (`unreachable`, `http-NNN`, `bad-call` from a box a
release behind) means not confirmed, and the asker decides. The answer is
held to its shape (`bad-reply`) and 2 MB, and the CC holds a tool's
output to 64,000 characters itself (else its head, `truncated`), whatever
the box sent. No box list shows `tool_job`.

### Company sign-in from the CC

Owner decision (option B, 2026-11-12, plan "SSO setup from the Control
Center"). Before it, the channel left sign-in out: a box's Admin pasted the
client secret on each box's own setup screen. Now a CC Admin stages a
box's Entra tenant ID, client ID and client secret from one page (Fleet >
Company sign-in), and runs the Test. The secret never changes hands: a
person pastes it once at the CC, and the box seals it with its own master
key.

Why it is acceptable: the CC is already the authority over its boxes
(option A above; a taken CC is a taken fleet). Staging the tenant and the
client ID needs the box's mode word `setup` (sign-in off). A changed issuer
signs nobody in until people link again (a link is issuer plus subject).
Company sign-in never makes a login or an admin.

The mode too, one way only (owner, 2026-11-12, follow-up B+): the CC raises
a box's mode one step at a time (off, setup, optional, required), never
down, and only while the box `.env` has no `MANTLE_OIDC_MODE` line. The
`.env` line is the only way down, so a person at the box can always turn
sign-in down or off. Why: the secret and the whole setup never need a
person at each box, while the box owner keeps the last word. Once a box is
live the CC cannot go back to `setup`, so its issuer stays until a person
steps it down. The step to `required` asks a warning to be confirmed first
on the CC page; a mistake is undone with `optional` in the box `.env`.

Four fixed cases on the signed route, not tools, so the rule "never a
person-only tool on the channel" stays true
(`server/web/lib/control/sso-channel.ts`). `MANTLE_CONTROL_CENTER_SCOPE=none`
refuses all four (`scope`); a box owner who does not want central sign-in
setup says so there.

- `sso_status`: the mode word, the tenant, issuer and client ID with where
  each comes from (`env` or `row`), where the secret comes from and when it
  was set (never its value), the redirect URI to register, and two numbers:
  active logins linked to the issuer, and all active logins.
- `sso_set { nonce, by, tenant?, clientId?, secret? }`: the tenant and the
  client ID are GUIDs; the issuer is built from the tenant
  (`https://login.microsoftonline.com/<tenant>/v2.0`; another cloud or
  provider stays a `.env` line). Two checks: (1) the tenant and the client
  ID only while the mode word is `setup`, the secret in any mode but off,
  and a value the box `.env` holds is refused (`env-wins`); (2) in
  `optional` or `required` a new secret is saved only when the Test with it
  answers `ok` (else `test`, with the code), so a wrong paste never breaks
  sign-in. A changed tenant or client ID clears a stored secret the same
  save does not replace (`secretCleared`): a secret is never sent to another
  issuer or with another app (so save the three together). The nonce is
  the call id, as `tool`'s. The audit row names `by`, the fields and the
  answer, never a value of the secret.
- `sso_test`: one Test with the saved values (the setup screen's own).
- `sso_mode { nonce, by, mode }`: raise the mode to `setup`, `optional` or
  `required`. Two checks: (1) the box `.env` has no mode line, else
  `env-wins`; (2) exactly one step above the mode the box runs now, and
  into `required` only while required can work there, else `mode`. The
  answer names the mode before (`from`) and the status after. Web applies
  it at once (a raise into `required` ends the sessions the rule refuses,
  as a boot into it does); the other processes within 60 seconds. The audit
  row names `by`, the mode asked and the answer.

At the CC: `POST /api/fleet/sso` (CC Admins, the settings area, its own
rate limit, a person only: no MCP tool, no agent, no API key, as an agent
that sets a secret or an issuer decides who signs in). A save and a raise
(`do: 'mode'`) ask the person's own password, the setup screen's fresh
check. The call travels as
a job of the control service, as `tool` does (`control_boxes.tool_job`, the
args sealed with the CC master key and dropped as the service takes them).
The CC's own audit row (`fleet.sso_set`, written before the call is
queued) keeps the box, the fields and a hash of the tenant and client ID,
never the secret; a raise's (`fleet.sso_mode`) the box and the mode asked.
Each answer is kept as the box's sign-in view
(`control_boxes.sso_view`, migration 0371): the status, the last Test code,
the last save and the last raise, never a value of the secret. The box screen (Admin >
Company sign-in) keeps working for a box with no CC.

The CC's own box (owner, 2026-11-13): the same page and route, with
`boxId: 'self'` (`boxIds: ['self']` for status and Test). The route runs
the box's own case code in process (`runSsoCase`, the code the signed route
runs after its scope line and nonce), with no job and no view: the status
is read live. The same CC Admin, the same password step, the same rules.
`MANTLE_CONTROL_CENTER_SCOPE` does not apply to it: it is about calls that
come in from a CC, and here the person is at the box. Its audit row
(`fleet.sso_set`, `fleet.sso_mode`, `boxId: 'self'`) is written after the
run, with the result. The way down is this box's `.env`
([oidc-sign-in.md](oidc-sign-in.md), "The Control Center's own box").

### Roll order

1. The CC first: migration 0370, the route, the tools and the control
   service. A box a release behind answers `bad-call` (for the sign-in
   cases too: migrations 0371 and 0372). A box whose `.env` holds a
   `MANTLE_OIDC_MODE` line keeps it: remove it with
   `scripts/sso-env.sh <box> --mode cc` to hand the mode to the CC.
2. Each box rolls. **A linked box gets `admin` reach at once, with no
   `.env` edit** (owner decision). Before rolling a box whose owner does
   not want it, set `MANTLE_CONTROL_CENTER_SCOPE=none` there first.
3. Close the channel alone: `MANTLE_CONTROL_CENTER_SCOPE=none` and restart.
   Unlink the box: remove the two CC lines.

## Unlink

- From the box (the box owner always wins): remove the two lines, then
  `docker compose up -d`. Every control call is refused at once. To keep
  the link and close only the admin channel, set
  `MANTLE_CONTROL_CENTER_SCOPE=none`.
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
| `POST /api/fleet/settings`      | `control_fleet_settings_set`                                 |
| `POST /api/fleet/tool`          | `control_tool_call`, `control_tool_list`                     |
| `GET /api/fleet/default-model`  | `control_default_model_get`                                  |
| `PUT`, `DELETE` the same        | `control_default_model_set`                                  |

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
- Fleet writes: a slow box (it answers, but slowly) holds its run's lane
  while its write job goes, up to 40 calls; and a CC Admin who queues
  several full jobs for one box within a minute can meet the box's call
  limit (120 a minute), so the later changes answer `http-429` and come
  off the job, not done. Send again. A trusted Admin's own burst; no guard.
- The admin channel (owner decisions: option A, and admin by default,
  2026-11-12): anyone who takes the CC (its control service's key) can run
  every tool the box's scope allows, on every linked box: by default
  `admin`, its settings, agents, models, keys (set, never read) and
  workspace members; with `full`, its data too. A roll gives every linked
  box `admin` reach with no `.env` edit. That is the cost of a CC with
  authority, and the owner's choice; a box owner opts out with
  `MANTLE_CONTROL_CENTER_SCOPE=none`, or unlinks with the two lines.
- With `admin`, the CC can pair a vault key with any host it names: a tool
  group's integration (`tool_group_ensure`) sets its base URL and its key
  reference, so the key goes to that host the next time an agent there uses
  the group. That is a keys-area power, as for a box Admin by hand. The CC
  never reads a key back.
- A replay of a `tool` call right after the box restarted (the nonces are
  in memory): it needs the TLS traffic first and a restart within the 60
  seconds. A box Admin's own restart; no guard.
- A tool's answer reaches the CC Admin and their agent: with `full`, that
  is box data on the CC. Treat it as text, not as an order, as with
  submissions.

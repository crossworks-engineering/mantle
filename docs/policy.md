# The box policy

The box policy is a small set of rules an operator puts in the box `.env`.
The app reads them once when each process starts. No screen in the app can
change them, so a box admin cannot turn a rule off. A company can put the
same block on every site.

An empty or missing value is no rule. A box with every value empty works
exactly as a box without this feature: the same sign-in, the same setup, the
same agents, workers and MCP tools, the 8-character password rule, no Policy
panel and no boot check. `packages/config/src/policy.test.ts` and
`server/web/lib/policy-empty.test.ts` pin this.

```sh
MANTLE_POLICY_TELEGRAM=off
MANTLE_POLICY_MODEL_DENY=deepseek/*,qwen/*,qwq/*,moonshotai/*,kimi/*,z-ai/*,glm/*,minimax/*
MANTLE_POLICY_PROVIDER_ALLOW=foundry,local
MANTLE_POLICY_ENDPOINT_ALLOW=llm.example.internal:1234,corp-ai.openai.azure.com
MANTLE_POLICY_PASSWORD_MIN=12
```

A value that is set but cannot be read (a typo such as `of`, a minimum of 6)
stops the web and API processes at start-up with the name of the setting
(`assertEnvShape`). A worker that starts anyway reads the strictest meaning
(Telegram off, a deny list that blocks every model, the strictest password
rule the value allows), never a looser one.

The one reader is `packages/config/src/policy.ts`. Each rule then has one
gate, and every path goes through it.

## Telegram

`MANTLE_POLICY_TELEGRAM=off` switches Telegram off for the whole box.

- The poll worker (`server/web/workers/telegram-poll.ts`) logs one line and
  polls nothing.
- The Bot API transport (`botFor`, `packages/telegram/src/client.ts`) refuses,
  so no path sends, edits or reads anything on Telegram. A reminder whose
  channel is Telegram fails to send and is tried again each tick until
  Telegram is on again or its channel changes; a heartbeat on a Telegram
  chat still runs its turn and drops the reply.
- The `telegram_*` tools leave every agent's tool list
  (`effectiveToolSlugs`) and the MCP tool list (`buildMantleMcpServer`). The
  grants stay.
- Every Telegram settings route answers `403 { error, code:
'policy_telegram_off' }` (the route switch `telegram-policy`,
  `server/web/lib/auth/route-switches.ts`).
- Every bot, channel, chat and pairing row stays. Remove the setting and
  restart, and Telegram works as before.

`on` or empty: Telegram works as configured.

## Models

Two settings, used together (one is fine too):

- `MANTLE_POLICY_PROVIDER_ALLOW`: the only provider ids any route may call
  (the ids of `packages/voice-client/src/providers.ts`: `openrouter`,
  `local`, `foundry`, `anthropic`, and the rest). This catches aggregators
  and model names a deny list does not know yet. An allow-list that names
  nothing allows nothing; an id it does not know (a typo) allows nothing
  either. This is the primary control: a deny list only knows the names it
  lists.
- `MANTLE_POLICY_ENDPOINT_ALLOW` (read only with a provider allow-list):
  the hosts a route's own base URL may name (`host`, `host:port` or
  `*.domain`). Name exact hosts for a shared cloud: anyone can make a
  resource under `*.openai.azure.com`, so that wildcard would admit any
  tenant's deployment. Without it an allowed provider could be pointed at any API
  (a `local` or `custom` route at a vendor's servers). With a provider
  allow-list and no endpoint list, no route may name a base URL: only the
  box-level endpoints (`MANTLE_LOCAL_CHAT_URL`, `MANTLE_FOUNDRY_ENDPOINT`,
  the local embedder's) are used. OpenRouter never honours a base URL.
- `MANTLE_POLICY_MODEL_DENY`: model patterns no route may call. A pattern is
  a glob on the model id (`deepseek/deepseek-chat`, `qwen/*`); one with no
  `:tag` also blocks the id's variants (`:free`, `:nitro`); a bare word is a
  family (`deepseek` is `deepseek/*`), the safest form. A family
  pattern `<family>/*` also blocks the provider of that name (the direct
  `deepseek` provider), a model id with the family as a path segment, and a
  local model name that starts with the family (`qwen2.5:7b`). While a deny
  list is set, a model that picks its model per call is blocked too:
  `openrouter/auto`, any `openrouter/` id, an id ending in `/auto`,
  `router` or `recommended` (Mammouth's own pick), and an OpenRouter preset
  (`@preset/...`). Family names do not
  catch a model sold under another name (`glm` for `z-ai`, `kimi` for
  `moonshotai`): list those too, or rely on the provider allow-list. A
  speech or vision call that names no model uses its adapter's default,
  which only the provider rules check.

A Foundry deployment name says nothing about the base model behind it. For
Foundry, the list of deployments IT makes is the allow-list.

**One check, every inference path.** `assertModelAllowed`
(`packages/voice/src/adapters/model-policy.ts`) runs in the recording wrappers
every adapter the registry hands out goes through
(`packages/voice/src/adapters/spend.ts`), before each call: chat, the backup
route and failover, sub-agents and `invoke_agent`, the summarizer and the
extractor, the decider, embeddings, vision, speech and images, on every
provider (the direct `deepseek` adapter too). Web search builds its own
client and asks the same check by hand
(`packages/tools/src/builtins-research.ts`). The check covers the box's own
model routes. Model lists, the OpenRouter catalog and data tools, and
anything that makes its own HTTP calls (API tools, sandboxes, MCP
connectors, `web_fetch`) are not model calls: a corporate box that must
reach no other model API also needs egress control at its network edge.

A refused call throws `ModelPolicyError` before any byte leaves the box. The
person, the agent or the tool reads which setting refused it (never a host
or the matching pattern: those are in the boot log and the Policy panel). The brain opens a
provider alert with subject `model_policy` and code `policy`. On a chat route
with a backup the policy allows, the turn fails over to it. An embedding or
extraction failure also shows on its own alert, with the policy reason, and
the extract queue pauses as for any lasting provider failure.

**Pick lists and saves.** The model lists (`GET /api/models`,
`/api/models/explore`, `/api/ai-workers/models`, `GET /api/model-pools`, the
`model_catalog` tool) leave blocked models out, and do not ask a provider
off the allow-list for its list at all. A save of a blocked model is
refused with `403 { error, code: 'model_policy' }` (assistants, workers, model
combos, model pools, the embedder; `server/web/lib/model-policy-save.ts`).
Seeded defaults, the onboarding Models step and an agent clone are not
checked at save: the boot check names them, and every call is checked.

**The boot check.** With a policy set, the web process logs the rules at
start-up, then one line for every enabled assistant, worker and embedder
whose primary route (or a backup that is on) is blocked, and opens the
`model_policy` alert while any is (`server/web/lib/policy-check.ts`). Run it
before the policy goes on a live box: a blocked model breaks the agent that
uses it until it is moved.

## Passwords

`MANTLE_POLICY_PASSWORD_MIN=<n>` (8 to 64; bcrypt keeps a password's first
72 bytes) sets the password rule: at least
`n` characters, and not a common password from a list bundled in the image
(`server/web/lib/auth/common-passwords.ts`; no outside call, no symbol
rules). A password that is mostly a run (`123456789012`, `qwertyuiop12`,
`111111111111`) or has fewer than 4 different characters counts as common
too. With no value the rule is today's: 8 characters, no list.

**One function.** Every new password goes through `passwordProblem` and the
one hash, `hashLoginPassword`, which refuses a password the rule refuses
(`server/web/lib/auth/password-rule.ts`): signup, an invite accept, an
Admin's new login and password reset, a login's own change, and the
`onboard` script. A refused password answers `400 { error, code, min }`
with `code` one of `password_too_short`, `password_too_long`,
`password_common`.

**Checked once under the rule.** Each login records the minimum its
password was last checked against (`auth.users.password_checked_min`,
migration 0347): at a password sign-in (the web sign-in and the device token
routes), at a password prompt (making an API key, MCP consent) and with a
new password. A new password set while no rule is in force records none,
so it is checked when a rule comes back. While a rule is set, a login whose password was never checked
under it (the rule went on, or up, since) answers as signed out on every
route but sign-out:

`401 { error: 'unauthorized', code: 'password_recheck_required', message }`

Its sessions, API keys, MCP connectors and linked brains wait until the
person signs in with the password once (the sign-in routes and the token
refresh act as no login, so they stay open; a refreshed token is still
held). So turning the rule on makes every login sign in once,
and that sign-in checks the password. A login used only through API keys
or a linked brain must also sign in once. The Policy panel and the boot log
count the logins still to check.

**The forced change.** When the password checked fails the rule, the
login's `must_change_password` flag is set (migration 0347), and a password
prompt grants nothing (no key, no consent). The login then reaches only the
routes whose declaration says `passwordHold: 'change-step'` or `'sign-out'`
(`server/web/lib/auth/route-declaration.ts`; only a row that acts as the
login declares one), and the public rows that act as no login:

- `POST /api/auth/change-password`
- `GET /api/auth/whoami` (answers `mustChangePassword: true` and
  `passwordRule: { min, commonList }`)
- `POST /api/auth/logout`, `POST /api/auth/mobile-logout`
- `POST /api/auth/token/refresh`, `POST /api/auth/sso`

Every other route answers `403 { error: 'password_change_required', code:
'password_change_required', message, min, commonList }`
(`server/web/lib/auth/password-hold.ts`, asked once per request by the
gate). MCP refuses the login's connectors, keys and linked brains, and a
Telegram chat paired to it is refused with a short reply but stays paired,
until the change. A new password clears the flag. With no rule set neither
column is read (a new password and the first owner write the values a box
without a rule already holds: false and null), so a box whose operator
removes the rule lets every login through again.

A password change ends the login's other sessions and revokes its API keys,
MCP connectors and linked brains, as every password change does; a forced
change too. A person held on turning the rule on makes new keys after the
change.

Not held: a `?at=` file link (two hours at most), a print's render cookie
and an app frame ticket (minutes) minted before the hold, a public share
link, and work the login scheduled earlier (heartbeats, runs) or messages
sent to it (push, reminders).

## The Policy panel

`GET /api/policy` (Admin users with the settings area) answers the policy in
force, every blocked route and how many logins the password rule holds
(`BoxPolicyReport` in `@mantle/client-types`). With no policy set it answers 404, so the panel
does not appear. It is read only: nothing in the app changes a rule.

## Rollback

Migration 0347 adds `auth.users.must_change_password` and
`password_checked_min` and the provider alert subject `model_policy`. Before
pinning an older image, run its revert,
`packages/db/rollback/0347_must_change_password.revert.sql` (required, not
optional): it clears every login's checked rule (the older image writes a
new password without one, so the roll forward checks every login again),
removes the `model_policy` alerts and narrows the subject check; the columns
stay. An
older image has no hold: a login that was held signs in as before.

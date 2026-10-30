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
MANTLE_POLICY_MODEL_DENY=deepseek/*,qwen/*,moonshotai/*,z-ai/*,minimax/*
MANTLE_POLICY_PROVIDER_ALLOW=foundry,local
MANTLE_POLICY_PASSWORD_MIN=12
```

A value that is set but cannot be read (a typo such as `of`, a minimum of 6)
stops the web and API processes at start-up with the name of the setting
(`assertEnvShape`). A worker that starts anyway reads the strictest meaning
(Telegram off, the floor of the password rule), never a looser one.

The one reader is `packages/config/src/policy.ts`. Each rule then has one
gate, and every path goes through it.

## Telegram

`MANTLE_POLICY_TELEGRAM=off` switches Telegram off for the whole box.

- The poll worker (`server/web/workers/telegram-poll.ts`) logs one line and
  polls nothing.
- The Bot API transport (`botFor`, `packages/telegram/src/client.ts`) refuses,
  so no path sends, edits or reads anything on Telegram (a reminder whose
  channel is Telegram is skipped as a failed send).
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
  nothing allows nothing.
- `MANTLE_POLICY_MODEL_DENY`: model patterns no route may call. A pattern is
  a glob on the model id (`deepseek/deepseek-chat`, `qwen/*`). A family
  pattern `<family>/*` also blocks the provider of that name (the direct
  `deepseek` provider), a model id with the family as a path segment, and a
  local model name that starts with the family (`qwen2.5:7b`). While a deny
  list is set, a model that picks its model per call is blocked too:
  `openrouter/auto`, any `openrouter/` id, an id ending in `/auto`, and an
  OpenRouter preset (`@preset/...`).

A Foundry deployment name says nothing about the base model behind it. For
Foundry, the list of deployments IT makes is the allow-list.

**One check, every path.** `assertModelAllowed`
(`packages/voice/src/adapters/model-policy.ts`) runs in the recording wrappers
every adapter the registry hands out goes through
(`packages/voice/src/adapters/spend.ts`), before each call: chat, the backup
route and failover, sub-agents and `invoke_agent`, the summarizer and the
extractor, the decider, embeddings, vision, speech and images, on every
provider (the direct `deepseek` adapter too). Web search builds its own
client and asks the same check by hand
(`packages/tools/src/builtins-research.ts`).

A refused call throws `ModelPolicyError` before any byte leaves the box. The
person, the agent or the tool reads the rule in the message. The brain opens a
provider alert with subject `model_policy` and code `policy`. On a chat route
with a backup the policy allows, the turn fails over to it. An embedding or
extraction failure also shows on its own alert, with the policy reason, and
the extract queue pauses as for any lasting provider failure.

**Pick lists and saves.** The model lists (`GET /api/models`,
`/api/models/explore`, `/api/ai-workers/models`, `GET /api/model-pools`, the
`model_catalog` tool) leave blocked models out. A save of a blocked model is
refused with `403 { error, code: 'model_policy' }` (assistants, workers, model
combos, model pools, the embedder; `server/web/lib/model-policy-save.ts`).
Seeded defaults are not checked at save: the boot check names them.

**The boot check.** With a policy set, the web process logs the rules at
start-up, then one line for every enabled assistant, worker and embedder
whose primary route (or a backup that is on) is blocked, and opens the
`model_policy` alert while any is (`server/web/lib/policy-check.ts`). Run it
before the policy goes on a live box: a blocked model breaks the agent that
uses it until it is moved.

## Passwords

`MANTLE_POLICY_PASSWORD_MIN=<n>` (8 to 128) sets the password rule: at least
`n` characters, and not a common password from a list bundled in the image
(`server/web/lib/auth/common-passwords.ts`; no outside call, no symbol
rules). With no value the rule is today's: 8 characters, no list.

**One function.** Every new password goes through `passwordProblem` and the
one hash, `hashLoginPassword`, which refuses a password the rule refuses
(`server/web/lib/auth/password-rule.ts`): signup, an invite accept, an
Admin's new login and password reset, a login's own change, and the
`onboard` script. A refused password answers `400 { error, code, min }`
with `code` one of `password_too_short`, `password_too_long`,
`password_common`.

**The forced change.** While a rule is set, a good password sign-in (the
web sign-in and the device token routes) checks the password it just
took. When it fails the rule, the login's `must_change_password` flag is set
(migration 0347). The login then reaches nothing but these routes until it
changes its password:

- `POST /api/auth/change-password`
- `GET /api/auth/whoami` (answers `mustChangePassword: true` and
  `passwordRule: { min, commonList }`)
- `POST /api/auth/logout`, `POST /api/auth/mobile-logout`
- `POST /api/auth/token/refresh`, `POST /api/auth/sso`

Every other route answers `403 { error: 'password_change_required', code:
'password_change_required', message, min, commonList }`
(`server/web/lib/auth/password-hold.ts`, asked once per request by the
gate). MCP refuses the login's connectors, keys and linked brains, and a
Telegram chat paired to it is refused, until the change. A new password
clears the flag. With no rule set the flag is never set and never read, so a
box whose operator removes the rule lets every login through again.

## The Policy panel

`GET /api/policy` (Admin users with the settings area) answers the policy in
force and every blocked route (`BoxPolicyReport` in
`@mantle/client-types`). With no policy set it answers 404, so the panel
does not appear. It is read only: nothing in the app changes a rule.

## Rollback

Migration 0347 adds `auth.users.must_change_password` and the provider alert
subject `model_policy`. Its revert,
`packages/db/rollback/0347_must_change_password.revert.sql`, removes the
`model_policy` alerts and narrows the subject check; the column stays. An
older image has no hold: a login that was held signs in as before.

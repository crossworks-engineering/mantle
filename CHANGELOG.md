# Changelog

Notable changes per release. Releases are tagged `vX.Y.Z`; every tag builds
the `linux/amd64` image (`titanwest/mantle:vX.Y.Z`) and attaches the matching
deploy bundle. Entries begin at v0.103.0 — earlier history lives in git.

## Unreleased: Four fonts, one library, every face variable (branch claude/variable-font-refactor)

**A typeface library is not a list of decorations.** The old one had grown into
two registries with different rules: twenty-two display faces for the wordmark,
twelve for the interface, most of them chosen to be striking for two words of
header. Anything you would actually set a document in was accidental.

There is now one library of sixteen families, and every one is a variable font
with at least two axes. One file carries every weight, and where a family has a
slant axis, its italic too.

### Four things you can set

Settings and Appearance now offers a face and a size for each of the interface,
the wordmark, the peer name, and a new one: **Pages and Notes**. That last is
the only typography choice in the product that leaves the browser, because it
typesets the PDF export as well as the editor and the share page.

Each row opens the same chooser rather than spilling the whole library down the
page: filtered by kind, previewing every face in your own text. The peer name
and Pages/Notes default to "same as interface", so a brain that picks one font
still looks deliberate. Sizes gained an Extra small, and the three new ones
scale only what they name; Interface size still scales the whole shell.

### The ranges are read out of the files, not typed

`scripts/fonts-import.mjs` parses each font's own `fvar` table for its real axis
ranges, converts to woff2, installs into both apps with the licence, and prints
the registry row. It refuses a face with fewer than two axes.

This is not tidiness. A variable font declared without its weight range makes
the browser treat the file as a single regular and fake the bold, which shows up
as smeared headings across every screen. Hand-typing sixteen sets of ranges is
sixteen chances to introduce that quietly.

Faces stay lazily fetched: a file downloads only when something actually paints
in it, so the library costs nothing until you choose from it.

### Two things that were already broken

The interface font never reached share links or `/print` at all. Only the two
header faces were stamped into those documents, so a share always rendered in
Inter no matter what the brain had chosen. Both surfaces now carry every font
the app does, which is what makes the Pages/Notes choice reach a PDF.

Separately, the Appearance screen showed Inter as the selected interface font
however you had it set. The face was applied correctly; the attribute the picker
reads its state back from was never rendered.

### What went away

Bukhari Script and the twenty-two decorative faces are gone. An existing brain
that had chosen one falls back to the new default rather than stranding, which
is what the registry contract has always promised. The default wordmark is now
Bricolage Grotesque, and Mantle's own mark in the footer follows it.

Only one monospace family survives the two-axis floor (Inconsolata). More can be
added at any time: that is now one command and one pasted row.

## Unreleased — The models you pinned, and whether they still exist (branch feat/model-drift)

**A pinned model is a decision, not a subscription.** It was right the day it
was chosen and nothing ages it. Nothing in the product ever checked whether the
ids `agents.model` and `ai_workers.model` actually send are still real — the
first sign of a delisted model is a failed conversation.

`pinned-model-drift` is a new read-only maintenance report, on the nightly
schedule alongside `deps-drift`. It reads every enabled agent and worker, asks
each provider what it currently lists, and reports pins that no longer exist
plus newer versions of the same family. It never rewrites a model: which one
you run is a cost and behaviour decision, and that stays yours.

It does not replace `models-drift`, and the two are easy to confuse.
`models-drift` is catalogue-level — does our onboarding dropdown still offer
what providers serve — and it deliberately skips OpenRouter, whose list is
built from the provider and cannot drift. That is true of a catalogue and false
of a pin, so this report covers exactly what that one skips.

**Most of the work here is in not crying wolf.** The naive version was written
first and pointed at the real fleet, where it confidently reported three
retired models across five healthy boxes. All three were the checker being
wrong:

- OpenRouter's `/models` enumerates **chat models only** — no TTS or STT id
  appears in it at all — so every voice worker read as dead. A pin is now
  compared only against catalogue entries of its own modality, and the modality
  comes from the row, never from the catalogue.
- `~x-ai/grok-latest` is a **real, current** id; the tilde is OpenRouter's
  auto-alias marker. Ids are matched exactly, never normalised or tidied. An
  alias is also never told that something newer exists — tracking the family is
  the point of pinning one.
- A provider with no list API, or one whose key is missing, tells us nothing.

So everything unjudgeable is reported as **not checked, with the reason**,
never as missing, and every cannot-see case is decided before any conclusion
about the id. A report that flags healthy pins gets muted within a week, and
then the genuine delisting goes unread too.

One judgement is stated wherever the output is read rather than buried in the
source: version segments compare as integers, so `4.20` is newer than `4.5`,
matching how these vendors number releases rather than how decimals sort.

## Unreleased — An assistant that answers to its own name (branch feat/agent-name-token)

**A copied assistant introduced itself as the one it was copied from.** Give a
login its own assistant called Tommy and his prompt still opened *"You are Mira
— a specialist assistant to a Risk-Based Inspection team"*, because cloning
copies the prompt verbatim and the name lived in the prose. Caught on a live
box the day per-login assistants shipped.

The name and the prompt were always two separate columns with nothing keeping
them in step, so the same bug was already there without any cloning: renaming an
agent in Settings → Agents writes `name` and never touches `system_prompt`, so
it kept introducing itself by the old one.

An assistant's name is now a token in its prompt — `{{name}}` — resolved once
per turn from the agent actually running. Rename it and the prompt follows;
copy it and the copy is itself.

Three things had to agree for that to be true:

- **Resolution happens at the composition seam**, the one function every
  surface routes through — real turns, delegated specialists, heartbeats, runner
  workers, the Studio sandbox, and Studio's composed-prompt preview. Substituting
  any deeper would have let the model see a name the preview didn't, which is the
  hidden prompt that seam exists to prevent. The name is a required argument, so
  a future call site cannot quietly omit it — which immediately earned itself:
  it caught a sixth call site (delegated specialists) that a search for the
  function had missed.
- **The persona bank stops baking names in.** New assistants are name-agnostic
  from the start. The token is declared in two packages because the bank is a
  browser-safe leaf that the resolver depends on, so importing back would cycle;
  a tripwire test fails if the two literals ever drift, and caught a missing
  export the first time it ran.
- **Cloning rewrites the source's name to the token, not to the new name.**
  Baking "Tommy" in would recreate the bug the moment anyone renamed Tommy.
  Whole-word and case-sensitive, so an assistant called Max doesn't turn
  "maximum" into a template.

A prompt that never mentions its own name is unchanged, byte for byte — the
cached prefix every turn depends on is untouched until a brain opts in. The
existing `{{secret:service/label}}` refs are a different mechanism resolved in
the HTTP tool dispatcher, and are never matched: their syntax appears verbatim
in the toolsmith skill's own instructions, and a greedy matcher would have eaten
the example it teaches from.

## Unreleased — Your own assistant, not everyone else's thread (branch claude/per-user-agent-duplication-60eb10)

**Two people signed into the same brain were talking to one assistant, in one
conversation.** Extra logins have always been co-admins on the anchor account's
data rather than tenants, and chat was never split off that: every login
resolved to the same default agent, and the conversation store is keyed
`(owner_id, agent_id)`. So a second person's turns appeared mid-thread, and
worse, each turn's history block handed the model the other person's words as
though the user had said them.

A login can now have its own assistant. In Settings → Users, name one when you
add a login (or later, from that login's panel) and pick which agent to copy;
the copy becomes that login's default chat target. Because the stream was
already keyed per agent — as are the live-turn NOTIFY payload, unread cursors,
digests and the inbox — one pointer, `agents.assigned_user_id`, splits all of
them at once. There is no new scoping model.

The copy is the same assistant with its own history: model, route, prompt,
skills, tool groups and delegation all come across, so it can reach the shared
specialists from its first turn. Three things deliberately don't:

- **Persona notes.** What an assistant learned about the person it was talking
  to is about *that* person. A copy starts with none.
- **Telegram.** A bot binding is a row against the old agent id, so a copy has
  no transport and no credentials — by construction, not by filtering.
- **Rank.** A copy sits one priority below its source. Headless callers (event
  reminders, heartbeats) break priority ties on slug, so an equal-ranked copy
  named `aaron` could quietly have become the brain's background default.

**This is separation, not privacy, and the screen says so.** The brain is still
one trust boundary: every login can open every assistant from the picker, and
`recall_window` replays any thread. What changes is that your chat is your chat.

The sticky agent cookie is per-browser, which would have made this land nowhere
for the exact people it's for — someone already chatting to the shared assistant
keeps landing there. The thread payload now carries when the assignment was
made, and the client switches over once against a local watermark; a deliberate
pick from the picker afterwards is left alone.

Releasing an assistant only drops the binding. The agent and its whole archive
stay, as an ordinary shared agent — deleting one remains a deliberate act on
Settings → Agents, same reasoning as the earlier fix that stopped agent deletion
destroying chat history.

## Unreleased — A picture where the sentence needs it (branch claude/vibrant-elion-4dda88)

**A chat reply could not put a picture mid-answer.** Every image a turn produced
was collected and rendered as a strip below the whole reply, in the order the
tool was called. For the case this feature exists for, an illustrated walkthrough
of a product manual, that is the wrong shape: the reader wants each step's
screenshot under that step, not a clump at the bottom to map back by counting.
v0.218.10 corrected the prompt to describe that limit honestly. This removes the
limit instead.

The renderer already had everything. Chat replies render through the same TipTap
schema Pages uses, image node included, and that node resolves a stored file from
its id. The missing link was one converter: `markdownToDoc` (Pages, server-side)
turned `![alt](media:<file-id>)` into a real image, while the chat converter let
it fall through to a broken `<img src="media:...">`. So the same syntax now works
in a reply, and the assistant writes each screenshot where it belongs.

Two converters drifting is how the bug happened, so the reference schemes
(`media:`, `page:`, `mention:`) moved to one dependency-free module both import,
with a test that runs the same markdown through both and fails if they disagree
about which picture goes where. The standalone form deliberately does not go
through `marked`: the `<p>` wrapper it adds makes ProseMirror close an empty
paragraph before the image, putting a blank line above every picture.

Three edges, decided rather than left to chance:

- **Shown twice.** A reply that writes the image inline *and* calls `show_image`
  for the same file used to show it in both places. The reply's own placement
  wins; the strip copy is dropped at finalize. Mechanical, not prompt-only,
  because a confused model doing both is exactly the case a prompt misses.
- **Mid-stream.** A half-typed `![alt](media:` is not a complete markdown image,
  so it stays literal text until the closing paren lands: no crash, no
  broken-image flash. The live stream buffer resolves finished markers through
  the same route the durable reply uses.
- **Telegram.** That surface sends plain text, where a marker would arrive as
  literal `![...](media:...)`. Inline markers are stripped on the way out and
  counted on the trace. `show_image` remains the only path that delivers a photo
  there, and `visual_answers` now says so.

No new surface area: the `<img>` hits the same owner-gated bytes route Pages and
the attachment strip already use. It answers unauthenticated with 401 and scopes
every read by owner id, so an invented or someone else's file id is a broken
image, never a leak.

## Unreleased — One implementation per tool, one verifier per credential (branch feat/arch-cleanup)

**24 MCP tools had two implementations, and the spare had gone stale.** Notes,
tasks, events, journal entries, peers and the email reads were each written
once as an in-app builtin and again by hand for the MCP server. Only the
in-app one gets exercised in development, so the MCP twin quietly fell behind:
`note_create` recorded no ingest provenance, so a note made from Claude Desktop
appeared in its own biography from nowhere; reads returned no permalink and,
worse, answered a missing row with a bare `not found` and no `isError`, which a
client reads as success; `task_list` returned a bare array where every other
surface returns `{tasks, count}`.

They are now bridged from the in-app definitions, so both surfaces run one
implementation. **This changes MCP response shapes** — if you parse these tools'
output in a connector, re-check it:

- `task_list` returns `{tasks, count}` (was a bare array).
- `task_get`, `note_get`, `event_get`, `journal_get` include a `url` permalink,
  and answer a missing id with a structured error flagged `isError` plus the
  tool that finds the right id.
- `note_create` / `note_update` accept a title over 200 characters by
  truncating it, where the hand-written tool rejected the call.

The MCP surface itself is unchanged: every slug that was exposed still is, and
bridging deliberately did NOT pull in the other members of those groups —
`email_send` and `email_page` in particular stay in-app only, since exposing
outbound email over MCP is a decision, not a refactor. `page_get`/`page_list`
and the table reads keep their hand-written ProseMirror/row shapes on purpose.
A test pins the remaining overlap exactly, so it can only shrink.

**The bridge also validated less than the in-app dispatcher.** Declared
preconditions were never checked, so an id naming a missing — or wrong-type —
node reached the handler and came back as an unhelpful `not found` instead of
the teaching error every other surface gives. And the JSON-Schema→zod
conversion silently dropped every size bound, so MCP was the only surface that
would accept `contact_list limit=500` against a declared maximum of 200. Both
are fixed for all bridged groups, including the seven bridged before this
change.

**The chat worker's "Test" button did not test what production runs.** It read
`api_key_id` directly, took the adapter and called `.chat()` — reproducing
neither of the two things chat routing actually does. So it lied in both
directions: a keyless `local` worker failed its test with *no api_key
configured* while working perfectly in production, and a worker whose primary
was down but whose backup was healthy also failed, though every real caller
would have been served. It now goes through `resolveChatRoutes` +
`chatWithFailover` — the production path — and reports which route answered, so
a green tick that came from the backup says so. The other modalities' test
buttons are left exactly as they were: they resolve keys the same way
`builtins-workers.ts` does, so they were already faithful.

Also hardened the embedding failover classifier, which decided 4xx-vs-5xx by
searching the message for any three-digit number — so an error mentioning a
dimension count or a port could be read as a client error and strand the caller
on a dead primary. It now prefers a status the error actually carries, and the
message fallback is anchored to the reported-status position. It stays separate
from chat's `classifyChatError` on purpose, with the reason written down: that
classifier reads a structured status the embedding adapters do not throw, and
its retryable set would drop 501 and proxy 52x — exactly what a self-hosted
primary behind a tunnel returns when it is down.

**Separately, `lib/auth` had five copies of its signature check.** There was a
shared `sign()` but no shared verifier: the split-on-dot, HMAC and
constant-time-compare preamble was pasted five times, differing only in which
kind byte followed — duplicated constant-time comparison in the module 265
others depend on. They now share one verifier, and the file splits along the
boundary its own comments already drew: `auth/tokens` (pure crypto),
`auth/session` (cookies, headers, `auth.users`) and `auth/request` (reading a
credential off a Request), behind an unchanged `@/lib/auth` façade. Four bearer
parsers that had genuinely diverged on whitespace become one, with the
null-vs-empty rule the gates depend on stated and tested; the rate-limit denial
shared by the four credential-exchange endpoints and the SSO origin check move
to `auth/preflight`. No behaviour changes — the kind-isolation matrix is now
pinned by a test that mints every credential and offers it to every verifier.

**The ten workers each hand-wrote the same shell**, and the copies had drifted
where it shows least: one shut down synchronously, two exited from a
`setTimeout` racing their own cleanup, and none bounded how long shutdown may
take — so a wedged `boss.stop()` left a container that looked alive and did
nothing until Docker's grace period ran out. `runQueueWorker` / `runWorker` now
own that shell; 1053 lines of worker become 715. Three things the fleet did not
have: signal handlers installed BEFORE setup (the three workers that block in
`waitForOwner` on a fresh brain previously met Node's default handler), a
shutdown deadline that exits non-zero and says so, and an explicit keep-alive —
"stays up" had been an accident of whatever handle setup happened to create.
Smoke-tested against a live Postgres: all ten start and stop cleanly in ~0.5s,
and a teardown that never resolves exits at 15.3s.

Separately, `pnpm dev` started **seven** of the ten workers. calendar, microsoft
and push each have a dev script and a production container and had simply never
been added to the list, so three ingest paths were dark locally while looking
fully wired.

**A deleted git worktree destroyed the local database, and could again.** The
dev stack mounts `${MANTLE_DATA_DIR:-./data}/postgres` relative to compose's
working directory, and the project name is pinned — so running it from a
worktree does not give you a separate stack, it gives you the SAME containers
pointed at a DIFFERENT data directory. A stack brought up inside a worktree put
Postgres' data there; removing the worktree pulled the directory out from under
a running database. `scripts/dev-compose.sh` now resolves the original clone
and operates there, `reset.sh` resolves its wipe target the same way, and the
rule is written into CLAUDE.md. Also `infra:psql` ran `docker exec -it
mantle_pg` — the PRODUCTION container name — so on a host running both stacks it
opened a psql session on production.

**The Runners screen 500'd on a restored brain.** The engine-absent guard knew
42501, 3F000 and 42P01 — all of them about schemas — but DBOS keeps its journal
in a separate DATABASE, and `pg_dump` is per-database, so a brain restored from
a bundle has none and Postgres answers `3D000 invalid_catalog_name`. A
provisioned cluster served by a read-only role says 42501 instead, which is why
the workstation passed and the deployed demo failed.

## Unreleased — Adding a Microsoft scope quietly killed every older account (branch claude/sharepoint-auth-directory-listing-d78be4)

**A connected Microsoft account had a shelf life measured from the last time we
edited a constant.** Every token refresh asked Azure for the app's *current*
scope list, but on the refresh leg Azure only honours scopes the user actually
consented to — anything beyond that set is not a widened grant, it's a rejected
request. So the day `Mail.Send` joined the list, every account connected before
it stopped being refreshable: `invalid_grant` / `AADSTS65001, the user has not
consented`. The account kept working until its access token expired, then went
dark, and the only cure was a reconnect nobody knew to perform.

The refresh no longer sends `scope` at all — omitting it re-issues exactly the
consented set, which is also what comes back on the response, so the granted
scopes we record (and gate outbound send on) stay accurate. The authorize and
code-exchange legs still ask for everything, because that is where consent is
actually given.

**The failure was also invisible from both ends.** Server-side, the refresh
error was recorded onto `ms_accounts.last_sync_error` *inside* the transaction
it then aborted by rethrowing — the write rolled back with everything else, so
an account that had been failing for a fortnight still read as healthy. It is
now written after the transaction unwinds. Client-side, a token failure threw a
plain `Error` with no status, so the drive browser's "reconnect the account"
branch never fired and the folder picker said only *Could not list the folder.
Try again* — advice that could never work. `invalid_grant` now carries a 401,
which is the branch that tells the truth, and the browse route logs the
underlying Graph error instead of swallowing it.

## Unreleased — The pictures inside your documents (branch claude/mantle-image-extraction)

**Every parser in the stack was text-only, so a diagram in a Word file or a
screenshot in a PDF manual was dropped on the floor** — invisible to recall and
to display alike. Some answers cannot be described, only shown: a screenshot of
a settings screen *is* the answer to "how do I configure this". Documents now
give their pictures up.

`extractEmbeddedImages` mirrors the text path's three tiers — docx through
mammoth's parsed document, pptx/xlsx/ODF through the zip and its relationship
files, PDF through pdfjs's image XObjects, and the legacy binaries through
Tika's `/unpack/all`, a capability that container always had and we had never
called. Extracted pictures become ordinary image files under
`files/extracted-images/<document>/`, which is what keeps the change small: the
extractor already indexes images (vision describe plus OCR, which reads the
labels *inside* a screenshot), and Pages already embeds a stored image by node
id.

**Reading order is the feature, not a detail.** A manual's screenshots are only
useful in sequence, and listing the media folder gives the wrong answer — part
numbering reflects when a picture was first embedded, and an image reused twenty
times appears once. So each extractor walks the document body and resolves
references to parts: slides in numeric order, sheets in workbook order, pages in
page order. Names follow a cascade of alt text, caption, then nearest heading,
rejecting Office's defaults (`Picture 3`) which look like names but say nothing;
titles carry meaning while filenames stay mechanical and zero-padded, so a plain
listing is reading order and a reworded caption can never orphan bytes.

Retrieval needed one addition. A vision worker looking at a cropped screenshot
writes "a mobile settings screen with several input fields" — true, and useless
for finding it, since nothing there names the manual or the step. Each image
stores its provenance and it is folded in ahead of the vision text, so the
summary, the embedding and the chunks all know where the picture came from.

**No model runs during extraction, and that is the point.** A sixty-slide deck
carries a hundred images — logos, bullets, one icon per slide — and describing
them all would be a hundred LLM calls. Pulling bytes out is free and always
happens; only survivors of deterministic filters (container, pixel dimensions,
byte floor, duplicate collapse, thirty per document) are worth a vision call.
The byte floor is deliberately *low*: flat line art compresses to about 2 KB, and
an initial 8 KB floor rejected precisely the diagrams this exists for. Pixel
dimensions do the real filtering.

Showing one is `show_image` in chat and `![alt](media:<file-id>)` in a page — no
new page machinery, since that syntax already resolved to a stored file. A
`visual_answers` skill carries the judgment: show rather than narrate, put each
step's screenshot beside its step, and never invent a file id. (At the time this
shipped, `show_image` did **not** place a picture where it was called: the chat
surface clumped every image from a turn into a strip below the whole reply. See
"A picture where the sentence needs it" below, which made the inline form work
in chat too.)

SVG is accepted, and is the best case rather than the risky one — vector stays
crisp at any zoom. It is safe because `safeDownloadHeaders` already serves it
under a sandboxed, network-less CSP and both display paths embed through `<img>`,
where SVG scripts never run. Office hides an inserted SVG behind a raster
fallback, so the OOXML walk prefers the vector; without that, an EMF fallback
would be dropped and the diagram would vanish with no error. EMF and WMF
themselves are dropped — no browser renders them — and scanned PDFs are left to
the existing OCR path rather than being mined for "figures" that are really just
pages.

Existing documents are swept by `pnpm -C server/web extract:images-backfill`,
dry-run by default. The documents themselves are free: the image pass sits ahead
of the extractor's already-extracted guard, so no text, summary or embedding
work re-runs.

Fixed while here: `upsertFile` reset a file's title to its filename on *every*
upsert, so any deliberately-titled file silently reverted on re-ingest.

## Unreleased — The rest of the "all good" over a dead brain (branches feat/healthcheck, feat/sanity-services, feat/test-timeouts)

**Four layers now have to agree before an install calls itself healthy.** The
installer work closed the reporting side; this closes the two places that were
still capable of staying quiet.

**The web container's healthcheck notices it has no network.** When a published
port can't bind, Docker abandons that container's whole network setup and the
process keeps running — attached to nothing, unable to resolve postgres,
unreachable by Caddy. Every HTTP-only check passes there, because 127.0.0.1
_inside_ the container works perfectly. It now asks `os.networkInterfaces()`
for a non-internal interface before asking whether the server answers.
Deliberately not a probe of postgres: Caddy gates on this check, so folding a
peer's health into it would let a routine database restart take the front door
down. "Do I have an interface" answers the real question and depends on nobody.

**The health check names services that were never created.** Everything else
can only judge containers that exist, so a service that failed to be created
dropped out of the report entirely. Removing `tika` from a live stack used to
read "All good — 23 healthy"; it now names it and exits non-zero. Safe because
the expected list honours `COMPOSE_PROFILES` from the install's own `.env` — an
opted-out embedder isn't reported missing, `sandboxd` is expected once
sandboxes are on.

Two bugs surfaced while building it. Repeating a label filter with the **same
key ANDs the terms**, so a query for two compose projects at once matches
nothing — the straggler cleanup in `uninstall.sh` was built on the opposite
assumption and was a silent no-op. And `sanity.sh` derived the stack directory
from its own location while accepting an env-file override, so `--stack-dir`
could read one install's `.env` against another's compose file; it honours
`MANTLE_STACK_DIR` now, and the installer passes it.

**Test timeouts, separately.** Two tests failed the pre-push gate on a green
tree, passed alone in 1.7s, and never failed on macOS. Both load modules
_inside_ the test body, so module resolution and the esbuild transform are
billed against the 5s `testTimeout` — and vitest runs about one worker per
core, so on a 24-core box under real load a `require('mathjs')` costing 411ms
idle sails past five seconds. `testTimeout` is now 15s, and mathjs moved to a
module-scope import so 18MB leaves the per-test budget entirely.

## Unreleased — An uninstaller, and a project-name bug it exposed (branch feat/uninstall)

**`scripts/uninstall.sh`** — there was no supported way to remove Mantle, so
everyone improvised, and the improvised version is the one that eats a
database. It splits the operation in two, because only one half is reversible.

The default removes containers, networks and named volumes and **keeps your
data**: postgres, the object store, files and backups are bind-mounted into
`MANTLE_DATA_DIR`, and the only named volumes are a tailscale socket and
Caddy's cert cache — so a re-install brings the same brain back with the same
keys. `--purge` additionally deletes the data directory and `.env`, which is
the brain plus `MANTLE_MASTER_KEY`; without that key a vault cannot be
decrypted even from a later backup, so it asks you to type `PURGE` rather than
press `y`. `--dry-run` prints the blast radius and changes nothing, `--images`
reclaims the ~4 GB of pulled images, and the whole thing refuses to run against
the `mantle-dev` development stack or without a terminal to confirm on.
Root-owned data (containers create it as root) is removed via sudo where
available and otherwise through a throwaway container — no password needed.

Writing it surfaced a bug in the installer merged earlier this cycle: port
ownership was keyed on a project name derived from the stack **directory**, but
both compose files set `name:` explicitly, and that wins. On any box not
installed into a directory literally called `mantle`, ownership detection
would have failed and every re-run would have relocated a working front door to
:8080. Now read from the compose file, with compose's own precedence.

Also fixed in both scripts: probing for a controlling terminal leaked
`/dev/tty: No such device or address` onto stderr in a piped or detached run —
redirections apply left to right, so the failure printed before `2>/dev/null`
took effect.

## Unreleased — Onboarding: orientation before the first message (branch feat/onboarding-tutorial)

**The last screen said "you're all set" and handed you to the assistant.** It
now says what to do with it, in four lines total.

The lead carries the thing that makes the rest cohere and that nobody guesses:
Mantle takes in whatever you give it and indexes it automatically — there is
nothing to tell it to learn or remember. People arriving from chat assistants
go looking for a "remember this" step, and since no builtin exposes that verb,
the search ends in doubt about whether anything was stored at all.

Then three items, and deliberately no more. Files are indexed on arrival, so a
document can be asked about the moment it lands (large ones take a minute —
extraction is a concurrency-capped queue, not an instant embed, and the copy
says so rather than promising magic). Email is gated on the contacts list: no
contacts means nothing inbound is ingested, which is indistinguishable from a
broken mail setup unless you're told it's deliberate — with the real carve-out,
that your own mail always comes in. And everything else happens by asking.

## Unreleased — Installer: guided setup, honest health checks (branch feat/install-probe)

**An install can no longer report itself healthy when it isn't.** A host port
already holding `:3000` made Docker abandon the web container's entire network
setup; it stayed `running` and `healthy` — its healthcheck only probes inside
itself — with no network, no postgres, and unreachable by Caddy. The sanity
check then confirmed the illusion: it probed `http://localhost:3000` first and
accepted any 2xx–4xx, so the squatter on that very port answered with Mantle's
own `307 → /login`. "All good — 23 services healthy" over a dead brain.

Now: the web container's debug port is configurable (`MANTLE_WEB_DEBUG_PORT`)
and the installer picks a free one; the health check probes the **front door**
and proves Mantle answered via `/api/auth/bootstrap-state` instead of trusting a
status code; a container running with no network or an unbound published port
fails loudly; and the check's verdict is the installer's verdict — a failure
ends in "Installation incomplete" and a non-zero exit.

The front door's host ports moved the same way (`MANTLE_HTTP_PORT` /
`MANTLE_HTTPS_PORT`), because a busy :80 killed a container that matters far
more than the debug tunnel. Without a certificate the installer just moves to
8080 and prints the address with its port; with a domain it refuses to move and
says why — HTTP-01 is answered on 80 and TLS-ALPN-01 on 443, so any other port
means no certificate, ever. `--behind-proxy` covers the box that already runs
nginx: Caddy on loopback:8080, the existing proxy keeps :443.

That also fixed a live bug in `MANTLE_SERVER_ORIGIN`, which the client app
serves to the browser as `apiBase`: it was hardcoded to `http://localhost` for
every non-domain install, so a `--lan` box sent every remote browser's API call
to its OWN machine. It now tracks the address the installer actually tells you
to open, port included.

The installer also asks the question that shapes the install — a domain with
HTTPS, this machine only, or this machine's network — instead of one yes/no
about a domain. `--localhost` binds the front door to loopback
(`MANTLE_BIND_ADDR`), which is the only thing that genuinely keeps a brain off
the network given a published Docker port bypasses the host firewall. A domain
is verified before TLS is enabled — every A **and** AAAA record against the
box's public and local addresses, via getent then dig/host — and a mismatch
offers a re-check, plain HTTP, another domain, or a clean stop rather than
letting Caddy burn that hostname's Let's Encrypt limit; unattended, it falls
back to HTTP instead of proceeding into a doomed request. Prompts read from
`/dev/tty`, so `curl … | bash` can ask real questions instead of answering them
all from an empty stdin. Disk, memory and ports 80/443 are checked before the
~2 GB pull.

## Unreleased — CLI Sandboxes (branch feat/cli-sandboxes)

**The coder agent gets a computer that isn't the brain's.** Persistent
isolated Ubuntu sandboxes managed by a new `sandboxd` supervisor (the third
docker-socket holder, fixed-verb by construction), opt-in per box behind the
`sandboxes` compose profile: clone and explain a repository, evaluate
untrusted code, build a service — with the work in a `/files` host dir that
outlives the container. Services published from a sandbox become normal
integration tool groups through a bearer-gated proxy (the SSRF guard's one
deliberate, test-pinned exemption); a keyless in-sandbox Claude Code MCP
toolbelt gives structured Read/Edit/Grep/Bash; three egress tiers (`full` /
`balanced` allowlist-proxy / `none`); a batteries-included
`titanwest/mantle-sandbox` base image (~5 s create-to-toolchain); a
`/sandboxes` master-detail surface; and the `sandbox-work` skill so the
grant arrives with its doctrine. Migrations 0138–0139; verified on the
workstation via four tool-layer batteries plus an 8/8 compose-profile demo
([full entry](docs/_changelog/unreleased-cli-sandboxes.md),
[feature doc](docs/sandboxes.md)). Version assigned at the release cut.

## v0.204.0 — 2026-07-26

**The team workspace reads inline — and the split mis-detection is fixed.**
Selecting a shared page, table, note, task, event, file, folder or formula in
`/team` (or the hub) renders the content in the reader pane itself: a new
`GET /s/<token>/view` returns the presenter payload as JSON (same
authorization as the `/s` page, cookie or bearer), and the share presenters
moved to `@mantle/web-ui/share` so both apps render one implementation. No
iframe, no "opens on the brain's own site" card. Pages arrive as
server-sanitized HTML; apps keep their `AppSandbox` execution sandbox.

Underneath sat the bug that produced that card: the client treated
"`MANTLE_SERVER_ORIGIN` configured" as "the API is cross-origin" — but the
installer sets it unconditionally, so **every default one-domain deployment
read as split**: redirect cards instead of content, bearer-only member
sessions, needless SSO detours. `isCrossOrigin()` now compares real origins,
and `POST /api/team/sso` with no `next` answers 204 + Set-Cookie — the silent
bearer→cookie upgrade existing sessions get on their next load. A genuinely
cross-origin client keeps the old top-level SSO behavior. No migrations, no
compose or config changes; e2e 31/0 across both topologies
([full entry](docs/_changelog/0.204.0.md)).

## v0.203.0 — 2026-07-25

**The formulas workbench.** `/formulas` becomes a place you can author a
calculation, not only read one: a signature calling-contract (`signatureOf` —
what must I hand this formula, per target, statically), a guided editor with a
live in-browser validation rail over one form+YAML draft, sharing a formula as
a `/s` live calculator (static equations + warnings render with no JS; only
the calculator is an island), Euler the mathematician specialist, and five
instructional seed formulas that double as the arithmetic regression suite.

Carries two pre-existing **fleet-wide** fixes found en route: copied share
links pointed at the client origin (which does not serve `/s` — broken for
every node type since the member carve), and `client/web` Tailwind never
scanned `packages/web-ui`, so every Switch and Checkbox rendered with no
checked state ([full entry](docs/_changelog/0.203.0.md)).

## v0.202.1 — 2026-07-25

**Release-engineering fix — use this tag, not v0.202.0.** The split's release
matrix (its first real run) collapsed to arm64-only: `platform` lived only in
the matrix `include`, whose entries merge into existing combinations with
later includes overwriting values earlier ones added — so both targets built
arm64 twice, and `mantle-{server,client}:v0.202.0` + `:latest` published as
**arm64-only manifests** unusable on amd64 boxes. (The server image's
`node:sqlite` probe caught it; the client had no such gate and published.)
No code changes vs v0.202.0.

- `platform` is now an original matrix dimension (a true 4-job cross
  product); the `include` entries only attach the runner.
- Two new tripwires in the merge job: exactly one digest per architecture
  BEFORE anything is tagged, and the pushed manifest must list both
  platforms — for both targets, closing the client's gateless publish.

## v0.202.0 — 2026-07-25

> **Do not deploy this tag** — its published images are arm64-only (release
> matrix bug, fixed in v0.202.1). Everything below shipped correctly in
> v0.202.1.

**The server tier runs Hono now — Next.js is removed from `server/web`.** After
the member carve (v0.201.0), `server/web` was an API-first tier: the whole
`/api/**` plane plus a handful of render surfaces, with almost no React left.
Carrying the full Next.js runtime — App Router, RSC, the Edge middleware
sandbox, `next build` — to serve JSON and two static pages was pure weight. So
`server/web` now runs a **Hono app under `@hono/node-server`, executed by
`tsx`** — the same runtime `server/api` and the workers have always used. Boot
is a sub-second `tsx server/main.ts`; there is no compile step. `client/web`
stays a Next.js app, untouched.

- **The gate is a faithful port of the Edge middleware.** Session-HMAC verify,
  the `k:'m'` mobile bearer, `?at=` asset tokens, `PUBLIC_PATHS`, and CORS
  (including the wildcard refusal on the credential-minting `/api/auth/**`
  paths, preflight-before-auth) all moved to `server/middleware/gate.ts`.
  Request path/method now travel via `AsyncLocalStorage` instead of injected
  `x-mantle-*` headers.
- **Route files kept their shape.** A local `NextResponse`/`cookies()`/
  `headers()` compat shim (`server/http-compat/`) and a generated,
  precedence-sorted route manifest (288 `app/**/route.ts` handlers, lazily
  imported and adapted onto Hono) mean the ~280 route files carry the same
  handler convention behind the seam — a mechanical, reviewable diff, not a
  rewrite. Migrating individual routes to native Hono idioms is optional
  future cleanup.
- **Render surfaces are hand-rolled, no Next renderer.** `/s/<token>`
  server-renders via `react-dom/server` with three client islands
  (app/table/token-prompt) bundled into `public/share-runtime/` (Tailwind v4
  CLI compile + esbuild + KaTeX); `/print/pages/<id>` is a plain HTML template
  around `renderPageDoc`; `/login`, `/hub`, `/team/*` are redirect stubs.
- **The HTTP contract did not change.** Same routes and shapes, same port
  (3000), same `/api/health`, and **no new env vars**. e2e is green in both
  topologies (29 passed / 0 failed), with SSE client-abort, 8 MB multipart
  upload, and share-asset `Range` verified live under the node server.
- **The Docker server image drops the compile step**: `build` is asset
  generation only (app-runtime, route manifest, share-runtime), and `CMD` is
  the exec form `pnpm -C server/web exec tsx server/main.ts` — exec, not the
  run-script form, so `SIGTERM` reaches the server instead of dying in the
  package-manager wrapper (`docker stop` settles in ~0.2 s rather than burning
  the full 10 s grace and taking a `SIGKILL`). The client target is unchanged.
- **`pnpm dev:fe` now runs `client/web`.** The client app is zero-secret and
  natively detached, so the old bearer-minting machinery is gone — you sign in
  on the login page. Config moved to `client/web/.env.detached.local`
  (`MANTLE_REMOTE=…` only; the legacy `server/web` file auto-migrates). The
  remote box must allowlist your dev origin (`http://localhost:3000`) in
  `MANTLE_API_CORS_ORIGINS` — the wildcard never covers `/api/auth`. See
  [`docs/db-less-dev.md`](docs/db-less-dev.md).
- **Scheduled backups work again on PostgreSQL 18 boxes.** The image shipped
  the PostgreSQL 17 client, and `pg_dump` refuses to dump a server newer than
  itself — so from the moment a box moved to pg18, every scheduled backup
  failed silently. The image now ships the **18** client (a newer `pg_dump`
  handles older servers, so pg17 boxes are unaffected). After upgrading, run
  one manual backup (Settings → Backups) to confirm the pipeline is alive.
- **Migration guide:** [`docs/upgrading-to-v0.202.md`](docs/upgrading-to-v0.202.md)
  — the full path from the single-image era to the split (DNS, env additions,
  compose adoption, per-box smoke checklist, the pg17-era notes, rollback).
- **The runtime moves to Node 26** (`26.5.0`, V8 14.6) — base image
  `node:26-slim`, `engines: node >=26`, `.nvmrc` and CI matched. Node 26 is the
  *current* line, not yet LTS; it promotes around Oct 2026, so until then this
  pin rides ahead of LTS deliberately, for the V8 and stream performance work.
  Nothing in the application tree needed changing: the only native/wasm
  dependencies (`@napi-rs/canvas`, `libsodium-wrappers`) are N-API/wasm and
  survive the ABI 147 bump untouched, and the `node:sqlite` engine probes that
  back Tables v2 and the per-app broker — the exact things a runtime bump would
  break — pass unchanged.
- **The image's base OS moves with it: Debian 12 (bookworm) → 13 (trixie)**,
  since that is what `node:26-slim` is built on. This broke the image build
  until fixed: the PostgreSQL apt repo line hardcoded `bookworm-pgdg`, which
  does not resolve on trixie, and `apt-get install postgresql-client` failed
  outright. The codename is now **derived from the base image**
  (`. /etc/os-release` → `${VERSION_CODENAME}-pgdg`) so the next base bump
  can't reintroduce it. Anything else that assumes bookworm package names in
  an image layer is worth a second look.
- **The brain's appearance is server-rendered — one delivery path.** The
  colour theme + the two display fonts (system-wide: they live on the anchor
  owner's profile row, so one admin choice brands every surface and every
  browser) now render straight into the `<html>` tag as attributes + inline
  font vars, everywhere: the client app's root layout fetches the new public
  `GET /api/appearance` server-to-server (30s cache, 2s timeout, fail-soft —
  a page never fails over branding) and the share/print surfaces read the DB
  directly. The old localStorage before-paint scripts are DELETED, not
  coordinated with: the document arrives correct, the client providers read
  the attributes back as initial state, and the theme-flash on a
  never-visited browser (which the client-origin split would have made
  universal) is gone. Semantics: share/print surfaces are the brain's brand —
  the owner's appearance is the only appearance, including branded PDF
  exports (still forced-white paper); a default choice is the absence of the
  attribute. The font picker also gains a home it never had: Settings →
  Appearance → Typography (it was previously mounted only on an unrouted
  demo page, so display fonts could not be set from the UI at all).
- **Footprint** (measured back-to-back on one host, idle boot): server image
  **1.81 GB, down from 2.01 GB** (the `.next` output is gone); settled RSS
  ~**643 MB vs ~683 MB** under `next start`; boot-to-ready ~3.2 s vs ~2.4 s —
  the +0.8 s is tsx transpiling TypeScript at startup (the same trade
  `server/api` and every worker already ship with), not request-path cost.
  The multi-minute `next build` disappears from the image build entirely.

## v0.201.0 — 2026-07-24

**The member carve — the split now covers the team surfaces.** `/team`,
`/hub` and the owner's `/team-admin` move off the server app into the client
tier, completing what v0.200.0 started: the server app's UI is now render
surfaces only (`/s/<token>` shares, `/print`, the login stub).

- **The team credential goes bearer-shaped.** The signed team-chat value is
  minted either as the classic cookie (same-origin) or as a bearer
  (`POST /api/team/auth {mode:'bearer'}`, held by the client app and sent as
  `Authorization`). One format, two carriers; the same per-request membership
  liveness — revoking a member still locks them out mid-session — and the
  raw-contact-token bearer (the MS Teams seam) is untouched. No ambient
  credential cross-origin means no CSRF surface.
- **Members ride the client origin.** The workspace, forum and hub fetch
  through the new `@mantle/web-ui/team-fetch` transport; live turn streaming
  is a fetch-based SSE reader (Last-Event-ID resume) because EventSource
  can't carry a bearer. Old `/team` bookmarks redirect from the server
  origin; members re-enter their 8-char token once (deliberate: forwarding a
  30-day credential through a URL fragment was rejected — fragments land in
  history and session stores).
- **Share reading hops origins safely.** Opening a briefing/team share from
  the client origin goes top-level through `POST /api/team/sso` — the bearer
  rides the form BODY (never a URL), a fresh server-origin cookie is minted,
  and `/s/<token>` renders exactly as before. Cross-origin iframes are not
  used (they can never carry the cookie, and third-party cookies are dying).
- **The designated hub app stays first-class**: the sandbox host page
  attaches the bearer to the app brokers (`bundle`/`tool-broker`/
  `db-broker`), which now accept it and answer CORS preflights — only those
  three `/s` sub-paths, nothing else.
- **`/team-admin` under the owner bearer**: per-tab `GET /api/team-admin/*`
  routes + a client page; "mark read" is now an explicit action, not a render
  side effect.
- e2e grows `team-bearer.spec` (exchange, cookie-free workspace, SSO
  open-redirect table, broker CORS scoping) + a team-admin smoke; the full
  suite gates both topologies.

## v0.200.0 — 2026-07-24

**The true server/client split.** Mantle is now TWO applications shipped as two
images from one lockstep release: **`mantle-server`** — the headless backend
(the full `/api/**` surface, the DBOS runner, every worker, and the public
surfaces: `/s/<token>` shares, the `/team` workspace, `/hub`, PDF print) — and
**`mantle-client`** — the owner UI, a ZERO-SECRET Next app holding no database
connection, no session secret, and no server code, driving the server origin
purely over bearer + CORS. Run the server alone for a headless brain; point any
client at any server via one env var (`MANTLE_SERVER_ORIGIN`, read per-request
— one prebuilt client image serves every box).

Under the hood: the owner web session is a first-class bearer (30-day tokens
via `POST /api/auth/token`, atomic rotation via `/token/refresh`, per-device
revocation with a **Signed-in devices** panel under Settings → Security); PDF
export works over ANY auth transport (the exporter mints its own short-lived
internal render cookie for the Chromium sidecar); the shared UI layer lives in
`packages/web-ui`; and an ESLint boundary makes a server-value import in the
client tier a build error. Deploys: `docker-compose.yml` (server) +
`docker-compose.client.yml` (client) share one `.env` and one
`MANTLE_IMAGE_TAG`; the server Caddy gains an `app.<domain>` vhost
(`MANTLE_CLIENT_SITE_ADDRESS`); the updater rolls and drift-checks both stacks.
A new end-to-end Playwright net (owner flows, SSE, asset tokens, shares, team
tokens, PDF, mini-app sandbox — run in BOTH topologies) gates the whole arc,
and set `MANTLE_PUBLIC_URL` on every box: the `NEXT_PUBLIC_APP_URL` server-side
fallback is deprecated.

## v0.160.2 — 2026-07-23

**Postgres 18 is the default; Tika and Chromium bumped.** The bundled database moves
to PostgreSQL 18 (pgvector `pg18` = PG 18.4 + pgvector 0.8.5) — fresh installs come
up on 18 directly. Postgres 17 → 18 is a *major* upgrade for an existing box (it
needs a dump/restore, not a tag swap), so the image is env-gated via
`POSTGRES_IMAGE_TAG` (default `pg18`; pin `pg17` to defer), and the service now sets
`PGDATA=/var/lib/postgresql/data` — the pg18 images moved the default data path and
otherwise refuse the existing bind mount. Full per-box migration runbook and rollback
in [`docs/postgres-18-upgrade.md`](docs/postgres-18-upgrade.md). Also bumped: Apache
Tika `3.3.0.0 → 3.3.1.0`, browserless/chromium `v2.54.2 → v2.55.0`, and the Ollama
(`0.32.2`) and Tailscale (`v1.98.9`) default image pins.

## v0.137.0 — 2026-07-16

**Tables v2.2: export formats + linked reference columns.** Export any table
straight from the grid via a format dropdown — **Excel (`.xlsx`)**, **Markdown**,
or **CSV** (a multi-tab workbook exports every tab). Linked **reference
columns** (`type: 'reference'`, from v2.1) gain a first-class grid affordance: a
🔗 menu on a linked column header to **Change source…** or **Delete link**
(unlink keeps the cell values as plain text). A reference is a convenience
picker — the chosen value is copied as plain text, Excel data-validation style,
so `table_sql` sees an ordinary column; soft integrity flags values missing
from the source as `DANGLING REFS` in the profile, and removing a source
degrades the column to plain text with values intact.

A reference column **always stores as text** — the engine maps `reference →
select` at every storage / read / filter boundary via `storageType()`. (An
earlier cut of v2.2 explored per-column reference *modes* — a checkbox variant
and a deferred multi — but they were removed before release: the checkbox mode
was flaky and the mode machinery widened the type surface for no user-visible
gain. A linked column now has exactly one behavior.)

**Deploy: tag-only bump — no migration, no compose change.**

## v0.136.0 — 2026-07-15

**Tables: reference columns from the grid + Excel-style cell expand.** Two UI
follow-ups to v2.1's reference columns, both grid-only (no engine/schema
change). (1) A **"Link to another tab…"** item in the column-header menu opens
a dialog to pick a source tab + column and turn the column into a cross-tab
reference — the shipped validation / draft-op / `ReferenceCell` pipeline does
the rest, so references are now creatable without the assistant. Retyping away
from reference clears the link. (2) Long **text/url cells** get an expander (⌘↵
save, Esc cancel): because the grid virtualizes on a fixed row height, the full
value opens in a portal popover instead of growing the row — no reflow, no
virtualization fight. Shipped after a 2-reviewer adversarial audit; fixes in
the same release (Esc-cancel now truly cancels; re-pointing a reference
refreshes its dropdown; a rejected op no longer wedges autosave).

**Deploy: tag-only bump — no migration, no compose change.**

## v0.135.0 — 2026-07-15

**Tables v2.1: multi-tab workbooks + cross-tab reference columns.** One Table
is now one SQLite workbook of N tabs (the Excel model): a tab bar switches
sheets, spreadsheet imports land every sheet as a tab of one node (the
sheet→tab flip — no more sibling tables), and a bare single-tab doc stays
byte-compatible with v2. New **reference columns** (`type: 'reference'`) offer
values from another tab's column, Excel data-validation style — soft integrity
(free text allowed, dangling values flagged in the profile, degrade-to-text
with values intact when a source is removed). An embedded **schema layer**
(data dictionary + join edges) backs `table_sql` and rides the corpus map as a
`schemaDigest`. The grid autosaves as **op batches** (`diffTableDocs` → the
`draft_rev` etag), scaling edits past the 10k window; reference cells get a
lazy typeahead editor (`?distinct=` on the rows route).

Shipped after a 3-reviewer adversarial audit; every confirmed finding fixed in
the same release. Notable fixes: formula↔stored column retypes are now DDL (a
retype used to leave the file unreadable); new-row runs and top-of-grid inserts
persist in the right order (op round-trip is now `applyOps(X, diff(X,Y)) === Y`);
autosave no longer drops edits typed during an in-flight save; the whole-doc
guards and truncation caps are draft-aware; `PUT /draft` carries the `if_rev`
etag; and file-replacing renames sweep stale `-wal` sidecars first. The
`draft-ops` route is now validated with a strict per-op schema.

**Deploy: tag-only bump — no migration, no compose change.** The `table-dbs`
mount and migration 0120 shipped with v0.134.0; v2.1 is code-only. Skill
bodies (`table_authoring`, `tool_grounding`) force-sync on the version bump.

## v0.134.0 — 2026-07-15

**Tables v2: sqlite-native table storage.** Each Table node now lives in its
own SQLite workbook file (`TABLE_DB_DIR`), with the Postgres registry row as
the lock spine (migration 0120, additive). Highlights: read-only `table_sql`
with a worker-thread watchdog; profile-only indexing (rows are never embedded
— schema/profile chunks + FTS trigram shadows replace row dumps); draft-op
batches with a `draft_rev` etag and WAL-safe commit-promote (VACUUM INTO +
atomic rename); windowed reads past the 10k materialize cap; `.sqlite` export;
part-splitting retired (2M-row explicit ceiling); lazy migration of legacy
JSONB tables plus a background sweep. JSONB dual-write is kept as the rollback
lever; blob retirement (`retire-table-blobs.ts`) lands next release.

**⚠️ Deploy note — compose refresh REQUIRED, a tag-only bump is not enough.**
This release adds the `table-dbs` volume mount (`TABLE_DB_DIR=/data/table-dbs`)
to the web and worker services. Refresh `docker-compose.yml` on every box
before `compose pull`, or table storage lands inside the container filesystem
and is lost on recreate. `db-dump.sh` and the scheduled backup now snapshot
the workbook files (VACUUM INTO) alongside pg_dump.

## v0.133.2 — 2026-07-15

**Hotfix 2: migration 0119's journal `when` predated 0118's**, and the
migrator gates on `when` > max recorded `created_at` — so boxes that already
ran 0118 skipped 0119 even with the journal entry present. Restamped to the
+1-day ledger convention; the journal guard test now also enforces strictly
increasing `when` values.

## v0.133.1 — 2026-07-15

**Hotfix: migration 0119 was missing its journal entry**, so the migrate gate
skipped it ("Already up to date") while v0.133.0's code queried the new
`content_chunks.search_tsv` column. Journal entry added; a new guard test
fails the suite whenever a migration .sql lacks a journal entry (or vice
versa). Boxes that rolled v0.133.0 self-heal on this release — the migration
SQL is idempotent.

## v0.133.0 — 2026-07-15

**Retrieval: hybrid passage search, spreadsheet profiles, corpus map.** Born
from a production recall audit. (1) `search_chunks` gains a keyword arm —
weighted RRF over the new `content_chunks` tsvector (migration 0119) with a
rescue floor, so exact rare tokens (error codes, field names, coined terms)
are findable even when they embed poorly; the responder's auto-context uses
it too. (2) Spreadsheets index as one profile chunk per sheet (headers +
sampled rows + honest coverage note) instead of thousands of embedded grid
rows — they were 74% of one brain's chunk table; full text still persists for
`file_read`. Versioned exports (date/`_version_NN` families) get their older
copies salience-down-ranked, newest self-heals. (3) Every responder turn now
carries a cached corpus map — branch-grouped titles (+ page/table one-liners)
on its own prompt-cache breakpoint, `memory_config.corpus_map_limit` to tune.

## v0.120.1 — 2026-07-07

**Duplicate block ids fixed + self-healing.** The page editor could mint two
blocks with one id (Enter-split copied the id; copy-paste re-imported it),
which made every later twin invisible to the block-level edit tools —
`page_block_get`/`update`/`delete` resolve the first match, so targeted
edits could land on the wrong block. The editor now re-mints ids on split
and paste (a new `appendTransaction` plugin in the `BlockId` extension keeps
the doc unique-id by construction), and server-side `ensureBlockIds` re-mints
any duplicate on read or save — first occurrence keeps its id, so held
addresses stay valid and already-corrupted docs/drafts repair themselves on
next touch, no migration. Also fixes `replaceBlock` id inheritance (the
"first new block keeps the target's id" contract was dead in production
because `markdownToDoc` mints ids at parse — every block update silently
churned the target's id).

## v0.120.0 — 2026-07-07

**Team Hub.** `/team` lands on a briefing hub — hero, curated briefing
cards, live brain stats, and Team Chat one tap away. Curation is just
sharing: the new **Team members only** toggle on a Page share puts it on the
hub; team-mode links now work for every content kind with automatic member
recognition from the hub. Full notes: `docs/_changelog/0.120.0.md`.

## v0.119.1 — 2026-07-07

**See what the validator sees.** v0.119.0's argument validation ships in
warn mode — recording what it *would* correct while changing nothing. The
new **`/debug` → Tool validation** tab makes that telemetry readable without
SQL: the box's active mode (with what it means and how to flip it), flagged
calls per tool over a selectable window (repairs / unknown keys /
violations, violations highlighted), and each recent flagged call in full
detail — violation texts, did-you-mean suggestions, repair notes — linked to
its trace. Violations are the enforce-flip question; a cluster on one tool
usually means a schema bug to fix first. Clean calls write no telemetry, and
the page says so, so an empty tab means "nothing flagged", not "no data".

## v0.119.0 — 2026-07-07

**Tool calls stop being a wild card.** Until now, most of what kept an
agent's tool use correct was *prose* — descriptions asking the model to pass
the right types, call things in the right order, and report honestly. This
release moves those rules into enforced machinery, end to end (the full
architecture: [docs/tool-reliability.md](docs/tool-reliability.md)):

- **Every call is validated against the tool's own schema.** Harmless drift
  is repaired automatically (`"42"`→`42`, a bare value where a list belongs,
  stringified JSON); real violations produce *teaching errors* that name the
  field, what was expected, what arrived, and the closest valid alternative
  ("did you mean 'limit'?"), so the model fixes itself in one retry. Ships in
  **warn mode** (telemetry only, zero behaviour change); flip
  `MANTLE_TOOL_VALIDATION=enforce` per box once its violation profile has
  been reviewed.
- **Flail loops get cut short.** A call repeated verbatim after failing is
  warned at the 2nd failure and blocked at the 5th; a call that keeps
  returning the identical result is blocked as no-progress. Re-reads whose
  results change are never penalised.
- **The turn reports what actually happened.** When a turn runs out of tool
  budget, the model is handed the runtime's own ledger — "17 issued, 14
  succeeded, 2 failed, 1 queued for approval" — instead of being asked to
  remember. The same numbers appear under the reply in /assistant, with an
  always-visible notice when any call failed: the reply can no longer quietly
  omit a failure, and a queued action is never reported as done.
- **Outside content is fenced by provenance.** Results from user-authored
  HTTP tools — and recipes that ran one — are now wrapped in the same
  data-not-instructions fence as web pages, and error messages are scrubbed
  of instruction-framing (role tags, fake `[system]` markers) before the
  model reads them. A hostile API endpoint can no longer inject directives
  through either path. Fenced content itself is never rewritten — the
  boundary is the defense.
- **Outward-facing actions get the approval gate.** `email_send`,
  `email_page`, `page_share`, and `contact_delete` now default to operator
  approval on new brains (existing brains keep their settings — tighten
  per-tool in Settings → Tools).
- **Wrong-id calls teach instead of confusing.** Pages/tables tools check
  their ids up front and say exactly what's wrong — including the case no
  handler used to catch: "that id is a *note*, not a page."
- **Multi-block page edits are atomic.** New `page_blocks_apply` applies up
  to 50 block edits in one all-or-nothing call (one draft save; any failure
  aborts with the failing op named). The half-edited-draft failure mode from
  the v0.118.0 incident is now structurally impossible, and jobs like
  "wrap all 47 quotes" cost one call instead of ~95.

## v0.118.1 — 2026-07-06

**Boot reconcile works on multi-admin brains again.** Since the actor/anchor
split (v0.111.0), a brain with more than one admin had several `auth.users`
rows — and the boot reconcile's "single owner" check read that as an
unprovisioned install and silently skipped. Prompt, skill, and tool-group
updates stopped reaching those brains on upgrade. Owner resolution now keys on
the single anchor owner of the brain's content (with the old single-user check
as the fresh-install fallback), so upgrades propagate everywhere again.

## v0.118.0 — 2026-07-06

**Big page edits no longer die halfway.** A large SOP restructure on a production brain
exposed a chain of agent-editing failures, all fixed here:

- **Write batches are atomic.** The tool-loop's volume caps (40 calls/turn,
  15/tool) used to trip *mid-batch* — a 10-delete batch got cut at 1-of-10 and
  left the draft half-edited. Caps now enforce at batch boundaries: a batch
  that starts under its caps always completes; when the budget ends the turn,
  the model is told explicitly so it reports what's done vs what remains.
- **`page_blocks_list` no longer lies about drafts.** It listed the published
  doc while the block-edit tools worked on the draft — so an agent looking at
  a broken draft saw a clean page and said so. The listing now reads the same
  editing baseline as the edit tools and flags `has_draft` /
  `draft_updated_at`; `page_get` flags the draft too.
- **Right tool for the job.** The pages agent now picks its edit strategy by
  size: block tools for targeted fixes, one whole-body `page_update_draft`
  pass for big restructures (with the markdown table pitfalls documented — a
  `# | …` header row parses as a heading, not a table).
- **Per-agent tool budgets.** `memory_config.max_tool_calls` /
  `max_calls_per_tool` override the flat caps; the pages agent ships with
  100/40. Specialist `memoryConfig` now force-syncs on upgrade (like
  prompt/model/params), so existing brains get the new budgets.

## v0.117.0 — 2026-07-06

**Team Chat — your team can talk to your brain.** Team members (the same
Contacts you mint team tokens for) get their own chat at **/team**: they enter
their token once and can ask the brain anything it knows — project history,
documents, decisions — with attachments and live streaming, in a private
thread that remembers them. What they *can't* do is change anything: the team
responder is strictly read-only, and any "please update / fix / add this"
becomes a **request** in your review queue, where you (or a specialist) act on
it and send the reply straight back into their thread.

You stay in full control from the new **Team** screen (`/team-admin`): every
member's conversation is visible with unread badges, each answer links to its
full trace, open requests sit under their own tab, and a per-member access log
records every sign-in, question, and denial. Two guard rails worth knowing:
your **email and journal are excluded by default** — a clearly-labelled switch
(with a warning) is required before team answers may draw on them — and each
member is rate-limited with a daily turn cap, so a leaked token can't run up
your model bill. Revoking a member (or deleting the contact) cuts their access
instantly, mid-session.

## v0.116.2 — 2026-07-05

**The app docs caught up with the app platform.** The app-authoring guide (and
the matching Claude Code builder skill) now covers everything the recent
releases added: full-screen apps that own their own layout, the two share modes
and exactly what each one may do, per-app databases as a first-class store
(concurrent-safe, included in backups), and the assistant's read-only view over
app data. Release notes for 0.114.0–0.116.1 were also filled in under
/changelog.

## v0.116.1 — 2026-07-05

**Smoother concurrent access to app data.** App databases now use SQLite's
write-ahead logging, so reading and writing an app's data at the same time no
longer block each other. You'll notice it where it matters: a team-shared app
several people use at once, or the assistant reading an app's data while the app
itself is updating it — those now proceed without stalls or the occasional
"database is busy" hiccup.

## v0.116.0 — 2026-07-05

**Your assistant can read your apps' data.** If a mini-app keeps its own
database — a tracker, an inventory, a log — you can now just ask about it in
chat: *"how many open items in my tracker app?"*, *"what's in the inventory
table?"*. The assistant discovers which apps have data and reads it directly to
answer. It's **read-only** — the assistant can look but never change an app's
data — and it works across all your apps with no setup. (Apps with clearly named
tables and columns are the easiest for it to answer from.)

## v0.115.2 — 2026-07-05

**Your app data is now in the backup.** Mini-apps that keep their own database
(lists, trackers, anything an app stores) were living outside the regular
Postgres backup. The backup now snapshots every app database alongside it — a
consistent copy taken safely even while an app is in use — so a restore brings
your app data back with the rest of the brain. Nothing to do; it's part of the
standard backup from now on.

## v0.115.1 — 2026-07-04

**Shared apps got safer, and gained an activity log.** Public app links are now
strictly limited to the app's *own* data — they can no longer reach your notes,
email, or other brain tools, so a "public" app can never become a window into
your private information. Team-shared apps stay full-featured for the people you
name, and every open, tool call, and data write is logged on the app's Activity
tab so you can see exactly who did what. Also tightened: the token entry screen
is rate-limited, and shared apps can only use built-in tools (never arbitrary
web or shell calls).

## v0.115.0 — 2026-07-04

**Share a mini-app with your team, full-screen.** A published app's Share
control now offers two modes. A **public** link is open to anyone who has it; a
**team** link asks the visitor for their team token (from their contact) and
lets in only your team members — every action they take is recorded against
them, viewable on the app's new Activity tab. Either way the app now opens in a
real **full-screen** frame, so dashboards and multi-pane layouts get the whole
window instead of a small embedded box.

## v0.114.0 — 2026-07-04

**Contacts can now be team members.** A new "Team member" toggle on any contact
mints that person a short access token (shown once — regenerate or remove them
to revoke it). On its own it changes nothing you'll see day to day; it's the
foundation for sharing apps with specific people, where the token both lets them
in and records who they are. Membership is the single source of truth: flip the
toggle off, or delete the contact, and their token stops working everywhere.

## v0.113.4 — 2026-07-04

**The cursor shows the moment an H1 is inserted.** A just-inserted empty H1
collapsed to a zero-width box, so the (correctly coloured since v0.113.3)
caret had nowhere to paint until the first letter arrived. The heading now
keeps a one-character minimum width.

## v0.113.3 — 2026-07-04

**You can see the cursor in an empty H1 again.** The Pages H1 gradient's
transparent text colour also hid the caret, so a freshly inserted empty H1
looked focus-less though typing worked. The caret is now pinned to the
theme's primary colour.

## v0.113.2 — 2026-07-03

**One version, one place.** The version badge next to the header wordmark is
gone — it duplicated the sidebar changelog link, which stays and now carries
the full build-identity tooltip (version · git sha · build date).

## v0.113.1 — 2026-07-03

**Centered page title, easier to read.** The floating title in the middle of
the header now uses the app font (Inter), smaller and bold, so longer titles
fit without truncating. The Bukhari script face is reserved for the wordmark.

## v0.113.0 — 2026-07-03

**Name your brain in the header.** A new **Site name** field in
Settings → Profile replaces the top-left "mantle" wordmark with your own
label — e.g. "Refinery" — so when you run several brains it's obvious at a
glance which one you're looking at. Leave it blank to keep the Mantle
wordmark; the header updates immediately after saving.

## v0.112.1 — 2026-07-03

**Complete release notes, in the app and in the brain.** Every release from
v0.82.0 onward now has an entry under /docs → Changelog (the 0.82–0.96 era was
backfilled from git history; 0.103+ notes moved into the per-version files the
reader and the Changelog collection actually use). Also ships the dev-tooling
fixes below.

### `pnpm reset` actually wipes the dev brain again

**`pnpm reset` actually wipes the dev brain again.** Since the v0.103 move
to bind mounts, `docker compose down -v` stopped deleting the postgres +
minio data (bind mounts survive volume removal), so `pnpm reset` claimed a
wipe it no longer performed. `scripts/reset.sh` now deletes
`${MANTLE_DATA_DIR:-./data}/{postgres,minio}` explicitly (via a container,
so container-owned files on Linux don't need sudo), shows the resolved data
dir in the confirmation prompt, and honors a root `.env` the same way
compose does.

- Docs caught up with the bind-mount reality: `architecture.md` §15 no
  longer documents the retired `mantle_pg_data` / `mantle_minio_data` named
  volumes (disaster recovery = `down` + `rm -rf` the data dirs);
  `deploy.md` §4 exports dev MinIO/files data with a plain `tar` off disk.

### Dev compose can no longer collide with a live prod stack

**Dev compose can no longer collide with a live prod stack.** The dev
compose (`docker-compose.dev.yml`) gets its own project name (`mantle-dev`)
and container names (`mantle_dev_pg` / `mantle_dev_minio` / `mantle_dev_tika`).
Previously it shared project `mantle` and the exact container names with the
prod `docker-compose.yml`, so bringing dev infra up on a host that also runs
a prod stack recreated the prod containers and took the live brain down
(2026-07-02 dev-box incident). Host ports are unchanged (54323 / 9000 / 9001
/ 9998), so existing `.env.local` files keep working.

- One-time migration on dev machines: old containers block the ports —
  `pnpm start` detects them and tells you to run
  `docker compose -p mantle -f docker-compose.dev.yml down` once (data is
  bind-mounted under `./data` and is reused as-is).
- `db-dump.sh` / `db-restore.sh` / `trace-node.sh` now autodetect the
  running container (`mantle_dev_pg` vs `mantle_pg`) and refuse to guess
  when both exist on one host; `MANTLE_PG_CONTAINER` still overrides.
- `sanity.sh` falls back to the `mantle-dev` project when the prod project
  has no containers.

## v0.112.0 — 2026-07-03

**Release notes your brain can read.** The changelog joins the documentation
system as a built-in collection: browsable under /docs and, once enabled
there, indexed by the brain — so "what changed in v0.99?" is answerable in
chat. Ships disabled by default; `_`-hidden folders stay out of every other
collection.

## v0.111.0 — 2026-07-03

**A calmer first screen, and frontend-only development.** The right-hand
Activity column starts hidden (expand with ⌘J; the choice sticks). New
`pnpm dev:fe` runs just the web app against a deployed brain — no local
Docker/Postgres; a box opts in via `MANTLE_API_CORS_ORIGINS` (plumbed through
compose). Runtime-verifying the detached path fixed three latent breaks
(layout onboarding gate, UsageCard's in-process DB read, cross-origin
credentialed fetches). First deployable image carrying v0.110.0.

## v0.110.0 — 2026-07-02

**Multiple admins, one brain** (untagged; ships in the v0.111.0 image).
Settings → Users manages additional full-admin logins (create / password
reset / delete) with a complete audit trail — logins, failed logins,
password changes, user management, and every mutating API call, attributed
to the acting login and durable past user deletion. Brain content stays
keyed to the anchor account; the anchor is undeletable, self-delete is
blocked, owner status is unreachable via the API.

## v0.109.3 — 2026-07-02

Completes the v0.109.2 sweep: the Tables grid's row/column IDs also used
`crypto.randomUUID()` bare (via `@mantle/content`'s table model), so table
editing would fail on plain-HTTP installs. Same fallback applied.

## v0.109.2 — 2026-07-02

**Assistant works on plain-HTTP installs.** Companion fix to v0.109.1:
browsers also remove `crypto.randomUUID`, `crypto.subtle`, the clipboard
API, and microphone access on non-HTTPS pages. The assistant composer
generated its idempotency key with `crypto.randomUUID()` and threw before
sending — pressing Submit silently did nothing. All client code now goes
through `lib/secure-context-fallbacks.ts` (UUID, sha256, copy-to-clipboard
fallbacks); voice input, which browsers hard-block over HTTP, shows a
clear "needs HTTPS" message instead of failing silently.

## v0.109.1 — 2026-07-02

**Login works on plain-HTTP installs.** On a no-domain install
(`MANTLE_SITE_ADDRESS=:80`, browsing by bare IP) the session cookie was
marked `Secure`, so browsers silently dropped it — login returned OK but
bounced straight back to the login screen, forever. Cookies (session +
Microsoft OAuth handshake) now take the `Secure` flag from the request's
actual scheme (`X-Forwarded-Proto`), so HTTPS installs behave exactly as
before and HTTP installs can actually sign in. Found on the first
plain-HTTP field install. HTTPS remains strongly recommended — see
`docs/installation.md` for pointing a domain at the box.

## v0.109.0 — 2026-07-02

**One install path.** The curl-able root `install.sh` now only bootstraps
(fetches the deploy bundle) and delegates configuration, startup, and
verification to the bundled `scripts/install.sh` — the same script used to
reconfigure a box later (`--domain`, `--check`). The deploy bundle now ships
`scripts/install.sh` + `scripts/sanity.sh`.

- `scripts/install.sh` gains `POSTGRES_PASSWORD` generation (kept on
  re-runs) and 80/443 port-in-use warnings.
- A release-tag `MANTLE_CHANNEL` now pins `MANTLE_IMAGE_TAG` to the same
  version, so bundle and image can't drift apart.
- Docs refreshed to match the product: online embedder default, the current
  onboarding wizard (system-status gate, Models, Memory), Sonnet 5 defaults,
  and this changelog added.

## v0.108.0 — 2026-07-02

- **Claude Sonnet 5 is the shipped default** for the assistant and the
  Sonnet-class specialists ($2/$10 per M tokens, 1M context — newer and
  cheaper than Sonnet 4.6). Existing brains: specialists move on upgrade;
  your assistant's model is operator-owned and never touched.
- Onboarding's OpenAI card is now GPT-5.5 (Azure-capable). Catalogs,
  pricing, and context tables updated for the new models.

## v0.107.2 — 2026-07-02

- **Fix:** re-saving an API key (e.g. resuming onboarding with a key already
  stored) hit a unique-constraint error that surfaced as a silent no-op.
  `setApiKey` now updates the existing key in place — with the ciphertext
  resealed against the existing row (AAD-safe).
- Onboarding surfaces request errors as toasts instead of swallowing them.

## v0.107.1 — 2026-07-02

- **Fix:** "Save & test" genuinely validates OpenRouter keys now — the
  models catalog is public (returns 200 for any key), so the probe validates
  against `GET /api/v1/key` first (bad keys get a clear 401 rejection).
- With a saved key and an empty field, the primary button becomes
  **Test saved key** instead of sitting disabled.

## v0.107.0 — 2026-07-02

- Onboarding's system-status panel gains a **Domain & HTTPS** row: proof-by-
  usage when you're browsing via the configured domain; DNS + server-side
  fetch verification otherwise.
- **Fix:** the installer never wrote `MANTLE_PUBLIC_URL`, so share/email
  links on installed boxes fell back to localhost. It's now derived from the
  chosen domain.

## v0.106.1 — 2026-07-02

- **Fix:** `text-embedding-3-large` via OpenRouter returned native 3072-dim
  vectors (the dimension parameter wasn't forwarded). The adapter now sends
  OpenAI's `dimensions` param and additionally truncates + renormalises
  (MRL) client-side, so the brain's 768-dim columns are always satisfied.

## v0.106.0 — 2026-07-02

- **System-status gate on onboarding step 1** — probes PostgreSQL, the
  pg-boss job schema, MinIO + bucket, Tika, and required secrets before the
  wizard begins; failures block Continue with a pointer to
  `scripts/sanity.sh`. A half-started stack now announces itself on the
  first screen instead of failing confusingly mid-wizard.

## v0.105.0 — 2026-07-02

- **Models step in onboarding** — curated, explained cards for the
  assistant's top-tier model and the background workers' fast model, running
  via OpenRouter (default, reuses your key) or **Azure OpenAI** (endpoint +
  key; OpenAI-family models). Choices apply at provision; everything remains
  changeable in Settings.

## v0.104.0 — 2026-07-01

- **Memory step in onboarding** — pick the embedding model
  (`text-embedding-3-large` recommended, `-small` budget) and route
  (OpenRouter — reusing the chat key, or OpenAI direct). The route is probed
  at 768 dims before the brain is pointed at it.

## v0.103.0 — 2026-07-01

- **Online embedder is the product default**; the local Ollama embedder is
  opt-in behind the `local-embedder` compose profile and no longer gates
  first boot (fixes fresh installs hanging on the model pull on restricted
  networks).
- **All persistent data bind-mounts under `MANTLE_DATA_DIR`** — postgres,
  minio, files, backups, app-dbs, Caddy certificates, ollama models. Nothing
  lives in named Docker volumes; `down -v` can't destroy data, and Caddy
  certs survive redeploys (no Let's Encrypt re-issuance).
- New `scripts/install.sh` (interactive + scriptable configurator with a
  DNS pre-check before enabling TLS) and `scripts/sanity.sh` (per-service
  health check with a clear pass/fail summary).

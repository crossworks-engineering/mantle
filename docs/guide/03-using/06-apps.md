# Apps

**Apps** is a mini-app builder — "Pages, but for little programs." Where Pages
gives you rich documents and Tables gives you typed grids, Apps lets you build
small, interactive tools: a weather widget, a unit converter, a habit tracker, a
dashboard against one of your integrations. You describe what you want; a
specialist agent writes the code, and it runs right inside Mantle, styled to
match your theme.

## How it works

An app is a small React/TypeScript program. You don't write it by hand — you ask
for it. The **Appsmith** agent (a specialist, like Pages or Tables) writes the
code using Mantle's own UI components, so the result looks native. It builds the
app, fixes its own compile errors, and leaves you a live preview to review.

There are two ways in:

- **Ask the assistant.** In chat (web or Telegram): *"build me an app that shows
  today's weather for Cape Town."* The assistant hands the job to Appsmith, which
  builds it and tells you where to find it.
- **Open `/apps` and create one.** Make a new app, then describe what you want in
  the **Assist** panel — *"a tip calculator with a bill total, tip %, and split
  between N people."* Appsmith writes it and builds the preview.

## Building your first app

The flow is the same every time — describe, review, refine, publish:

1. **Describe it.** Be concrete about what it should *do*, not how to code it:
   *"A tip calculator. Inputs for the bill amount, a tip percentage with quick
   25/30/35% buttons, and a 'split between' number. Show the tip, the total, and
   the per-person amount."*
2. **Let Appsmith build.** It writes the source, compiles it, and fixes its own
   errors until the build is green — then leaves you a live preview. This takes a
   few moments; you don't have to do anything while it works.
3. **Review the preview.** Open the app from `/apps`. The **Builder** tab shows
   it running, themed to match Mantle. Try it out.
4. **Refine in the Assist panel.** Ask for changes in plain language — *"round the
   per-person amount up,"* *"make the buttons bigger,"* *"add a dark card around
   the result."* Each change re-builds the preview. To target one area, click
   **Select element** and pick a region first — Appsmith then changes only that.
5. **Publish when you're happy.** Until then it's a draft — see below.

That tip calculator needs no outside data, so it works the moment it's built.
Apps that need *live* data (weather, prices, a lookup) have one extra step.

## Connecting an app to live data

Apps can't reach the internet directly — that's a deliberate safety boundary
(see [Safety](#safety)). When an app needs live data, it calls one of **your
tools**: the same API tools the **Toolsmith** builds in the
[API Console](../04-configuring/07-api-console-and-toolsmith.md). Appsmith asks
the Toolsmith to build the integration if it doesn't exist yet, then the app
calls it through Mantle. Your API keys stay on the server — the app never sees
them.

So when you ask for a weather app, three things have to line up, and Appsmith
walks them in order:

1. **The tool exists.** Appsmith delegates to the Toolsmith to build (and test) a
   tool for the service.
2. **The service is reachable.** If it needs an API key you haven't stored,
   Appsmith **stops and tells you** exactly what to add — e.g. an OpenWeather key
   under **Settings → API keys**
   ([Keys & local models](../04-configuring/04-keys-embedding-local-models.md)).
   Add the key, and the build resumes.
3. **The app is wired to it.** Only then does the app fetch real data.

If a service can't be connected yet, Appsmith will say so rather than ship an app
that looks finished but can't actually load anything. If your app shows a "data
isn't connected" message, that's the missing piece — usually a key to add or a
tool to approve under **Settings → Pending**.

## Apps remember their own data

An app can also keep its **own** data: a tracker remembers your entries, a list
remembers your items, a calculator remembers your last settings. Each app gets
its own private storage, isolated from every other app and from the rest of your
brain — so building a habit tracker doesn't require any setup, it just works.

App data is treated like real data: it's **included in the standard backup**
(a consistent snapshot, safe to take even while the app is in use), and its
storage handles several people using a shared app at once without tripping
over each other.

## Ask the assistant about your app's data

Data an app stores is part of your brain's world: the assistant can **read**
any of your apps' databases and answer from them in normal chat — *"how many
open items in my tracker app?"*, *"what's in the inventory table?"*. No wiring
needed. It's strictly read-only: the assistant can look, but only the app
itself can ever change its data.

## The editor — Builder and Code

Open an app from `/apps` for the full editor. The header has **Build** (recompile
after changes), **Publish**, and **Discard**, and the workspace has two tabs:

- **Builder** — the **live preview** of the running app (themed to match Mantle,
  including dark mode and your colour theme) next to the **Assist panel**, where
  you ask Appsmith for changes. This is where you'll spend most of your time. Hit
  **Select element**, then click a region of the preview to *point Appsmith at
  it* — your next request changes only that part and leaves the rest alone.
- **Code** — the app's **source files** in a file tree on the left and an
  **editor** on the right. Reading the code is optional, but you *can* edit it:
  type directly (with syntax highlighting), hit **Format** to tidy a file with
  Prettier, then **Save** to put your changes in the draft and **Build** to
  compile. You never have to touch it — Appsmith can do everything — but it's
  there when you want a quick hand-tweak.

Build errors, if any, are shown inline so you (and Appsmith) can see what failed.
Editing in the Code tab and asking Appsmith both write to the same draft, so do
one at a time — running Appsmith re-syncs the editor and drops unsaved edits, so
**Save first** if you've hand-edited.

## Draft, review, publish

Like Pages and Tables, edits don't go live immediately. Appsmith's changes land
in a **draft** — you review the preview, and when you're happy you **Publish**.
Until then the published app is untouched, and **Discard** reverts the draft.
Publishing only works once the app builds cleanly, so a broken change can never
go live.

## Tips for a good app

- **Describe behaviour, not code.** Say what it should do and show ("a grid of the
  next 5 days with high/low and an icon"), not which library to use.
- **Start small, then refine.** Get a working first version, then ask for changes
  one at a time in the Assist panel — it's faster than one giant request.
- **Name the data source.** If it needs live data, say which service ("use
  OpenWeather") and have its API key ready, so Appsmith can wire it without
  guessing.
- **One app, one job.** Small focused tools build and run more reliably than
  sprawling ones; make two apps rather than one that does everything.

## Sharing an app

A **published** app can be shared at an unguessable, revocable link — it opens
**full-screen**, so a dashboard gets the whole window. The Share control on the
app header offers two modes, and they grant very different things:

- **Public** (anyone with the link): the app becomes a self-contained,
  **read-only** view of its own data. It gets *no brain tools at all* and
  cannot write — so a public link can never become a window into your notes,
  email, or anything else in your brain. Good for a read-only dashboard or a
  reference tool.
- **Team members only**: the visitor is asked for their **team token** (the
  one minted when you mark a Contact a [team member](07-team-chat.md)). Once
  identified, they get the app's full capability — its granted tools and the
  ability to save data — and **every action is recorded against their name**
  on the app's **Activity** tab: each open, each tool call, each write.
  Removing a team member cuts their access immediately, mid-session.

Even in team mode there's a hard limit: a shared app can only use built-in
data tools — never web-request or shell tools — so a share can't hand anyone
arbitrary network or command access under your account. Treat any share link
as a secret; revoke it by turning the share off.

## Safety

Every app runs in a sealed sandbox: it can render its interface, call the tools
you've granted it, and use its own storage — and nothing else. It can't read your
other data, reach the network on its own, or touch another app's database. You
stay in control of what each app is allowed to do — and when you share one, the
share mode (above) decides how much of that capability travels with the link,
with public links locked to read-only self-contained apps. The full model is in
the [security overview](../../security.md).

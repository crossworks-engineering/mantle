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
- **Open `/apps` and use the Assist panel.** Create an app, then describe changes
  in the panel on the right — *"add a 5-day forecast in a grid,"* *"make the card
  more compact."* Appsmith edits the app and rebuilds the preview.

## Data and storage — without leaving Mantle

Apps don't reach the internet directly. When an app needs live data (weather,
prices, a lookup), it calls one of **your tools** — the same API tools the
[Toolsmith](04-pages-tables-notes-docs.md) builds in the API Console. Appsmith
asks the Toolsmith to build the integration if it doesn't exist yet, then the app
calls it through Mantle. Your API keys stay on the server — the app never sees
them.

Apps can also keep their **own data**: a tracker remembers your entries, a list
remembers your items. Each app gets its own private storage, isolated from every
other app.

## The editor

Open an app from `/apps` to get the full editor:

- A **live preview** of the running app, themed to match the rest of Mantle
  (including dark mode and your colour theme).
- The app's **source files**, so you can see exactly what Appsmith wrote.
- **Build**, to recompile after changes — any errors are shown inline.
- The **Assist panel**, to ask Appsmith for changes.

## Draft, review, publish

Like Pages and Tables, edits don't go live immediately. Appsmith's changes land
in a **draft** — you review the preview, and when you're happy you **Publish**.
Until then the published app is untouched, and **Discard** reverts the draft.
Publishing only works once the app builds cleanly, so a broken change can never
go live.

## Safety

Every app runs in a sealed sandbox: it can render its interface, call the tools
you've granted it, and use its own storage — and nothing else. It can't read your
other data, reach the network on its own, or touch another app's database. You
stay in control of what each app is allowed to do.

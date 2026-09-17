---
title: Apps
toolGroups: [apps, app-admin, app-data]
---

## Apps

Small single-purpose interfaces built on top of your own data, a job sheet, a
stock count, a booking form, a dashboard for one thing you check every morning.

An app is **real code**, not a configured widget. It's written as TSX, compiled
on the server, and rendered inside a sandbox. What makes it useful rather than
merely possible is that it can reach your actual brain: the same tables, files
and notes you use everywhere else, through tools you grant it one by one.

Every app has a **draft** and a **published** version. Edits land in the draft
and the live app is untouched until you publish, and a build that fails to
compile never replaces the last one that worked.

## Assistant

- "Build me an app for logging generator hours."
- "What apps do I have?"
- "Add a filter by month to the stock app."

Authoring is the interesting case. The assistant writes the source files,
compiles, and hands back errors with the exact file and line when it doesn't
build, so "it won't compile, fix it" is a normal part of the loop rather than a
dead end. It can also grant the app its data access and give it a small database
of its own for reference data.

Ask to review before publishing. The preview at an app's own page renders the
draft, which is the whole point of having one.

## Technical

Source is a virtual file tree stored on the app row, up to 50 files, 256 KB
each, bundled server-side by esbuild. The entry file must default-export an
`App()` component.

It runs in a **sandboxed, opaque-origin iframe**: no credentials, no
same-origin access. That is the security boundary, and it means an app cannot
reach your session, your cookies, or any data you didn't hand it. Data flows
only through a runtime allowlist of tool slugs set per app; the host refuses any
slug not on that list. An app may also declare its own SQLite database for
reference data it owns.

The bundler's import allowlist is deliberately short, React, a handful of UI
primitives, Lucide icons, the host bridge, and relative files within the app.
Any other bare import is rejected at build time rather than fetched. No
arbitrary npm, so an app's dependency surface is a fact you can read off this
list rather than a tree you have to audit.

Apps are also shareable, and a shared app runs under the same sandbox and the
same grant list as it does here.

---
title: Home
---

## Home

Home is the landing page of your current workspace. Pick another workspace in the switcher and Home changes with it.

- **The Built-in home** shows the workspace's data: how many items of each kind it holds, its newest pages, and the apps you may run there.
- **A home app** takes its place when a Moderator of the workspace picks one on the workspace screen, under **Landing page**. **Built-in home** at the top switches between the two.
- **All my workspaces** in the switcher shows the Built-in home over every workspace you are in.

The brain health **Dashboard** is in the menu, under System, for users who manage the brain's settings.

## Assistant

- "What changed in this workspace this week?"
- "Open the newest page about the rota."

## Technical

- Home reads `GET /api/home?ws=<id>`, in your own scope: you only ever see what your workspaces hold.
- A home app gets the same data through `host.hub.get()`. See [Workspace home apps](../07-api/07-member-home-apps.md).

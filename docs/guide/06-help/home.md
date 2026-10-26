---
title: Desk
---

## Desk

Desk is the landing page of your current workspace. Pick another workspace in the switcher and Desk changes with it. **All my workspaces** shows Desk over every workspace you are in.

Desk is a grid of widgets you arrange like a real desk:

- **Drag** a widget by its title bar to move it. A widget dropped onto others pushes them down; nothing moves on its own.
- **Resize** a widget by its corner grip. From the keyboard, the grip moves it with the arrow keys and resizes it with Shift and an arrow.
- **Pinned items** sit as desk icons down the right edge. Drag an icon anywhere; click it to open the item.

On a phone the widgets stack one under another, in the order they sit on the desk.

Your desk follows your login: arrange it in one browser and it looks the same in another browser, on another device and in the desktop app.

## Customize

Click **Customize** to open the desk's panel.

- **Workspace items**: a switch per kind (notes, pages, tasks and the rest) puts its widget on the desk or takes it off. Each widget lists your pins first, then what you opened last; drag its slider to set how many items it shows. Notes show as sticky notes.
- **Desk icons**: show your pinned items as icons, or hide them.
- **Tools**: the clock, the calendar, a quick note, the theme, Drift, a focus timer and more. Switch one on and it lands in the first free spot.
- **Tidy up** closes the gaps, moving every widget up as far as it goes. Left and right stay as they are.
- **Reset desk** puts the default desk back.

## A home app

A Moderator of a workspace can pick a home app on the workspace screen, under **Landing page**. The app then takes the place of the built-in Desk for that workspace, and **Desk** at the top switches between the two. If the app's build breaks, the built-in Desk shows instead.

The brain health **Dashboard** is in the menu, under System, for users who manage the brain's settings.

## Assistant

- "What changed in this workspace this week?"
- "Open the newest page about the rota."

## Technical

- Desk reads `GET /api/home?ws=<id>`, in your own scope: you only ever see what your workspaces hold.
- The desk's layout is kept on your login, not in the browser.
- A home app gets the same data through `host.hub.get()`. See [Workspace home apps](../07-api/07-member-home-apps.md).

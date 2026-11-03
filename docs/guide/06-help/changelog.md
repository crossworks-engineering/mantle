---
title: Changelog
---

## Changelog

The Changelog screen tells you what changed in each release of the brain.
Open it from the version line at the foot of the menu: it shows this app's
version and the brain's, and a dot means there is news you have not read yet.

The screen opens on the newest entry, marked **Latest**. Under it,
**Previous versions** links every older entry. On an older entry,
**Jump to latest** takes you back.

Opening any entry counts as reading it, so the dot goes away.

Only a login with the settings area (an admin) gets the link. Everyone else
sees the version line as plain text.

## Assistant

The assistant does not read the changelog. Open it here.

## Technical

- The screen reads `GET /api/changelog` from the brain. With no version it
  returns the newest entry and the list of versions; `?version=x.y.z` returns
  one entry, or a 404 when there is none.
- Entries are markdown files named `<version>.md` under `docs/_changelog/`,
  shipped in the brain's image. A version with no file there has no entry on
  this screen. The full release history is `CHANGELOG.md` in the repo.
- Whether you have seen the news is kept in this browser only. The dot comes
  back when this app moves to a new version.

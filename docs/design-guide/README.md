# Design guide

The design rules for building a mini app or a Present canvas (a deck, a
dashboard, a landing page). Only app and presentation work calls it (owner,
2026-11-16). Builders read it one section at a time with the `design_guide`
tool (`packages/tools/src/builtins-design-guide.ts`), straight from these
files, and nothing goes in a prompt. Only the opt-in System docs collection
(off by default) indexes them, as it does all of `docs/`, the diagram guides too.

- **In the brain:** the `design-guide` tool group, which only Appsmith and
  Presenter hold. Their skills (`app_authoring`, `canvas_authoring`) say
  which topic to read before a build. No assistant, persona or general group
  holds it.
- **Over MCP:** the tool is listed like every other tool. Its description says
  it is only for building an app or a canvas, and the app guide
  (`docs/app-authoring-guide.md`, read through `app_authoring_guide`) points
  at it. No other tool, and not the server instructions, names it.

**Scope.** Only apps and presentations. The Mantle interface itself keeps its
own rules: [`../../server/web/CLAUDE.md`](../../server/web/CLAUDE.md) and the
mantle-client UI rules.

## Source

[Impeccable](https://github.com/pbakaus/impeccable) (impeccable.style), by Paul
Bakaus, Apache License 2.0 (`LICENSE` here; `NOTICE.md` here keeps its notice).
Pinned at **skill v4.9.1**, tag `skill-v4.9.1`, commit
`acb4cfe14470b1fdf51e855431af618d936b7db8` (2026-11-14). Only the guide text is
taken. The skill's scripts and helper binary are not vendored and never run.

## What is here

- `upstream/`: files copied unchanged from
  `.claude/skills/impeccable/reference/` at that commit: `craft-floor.md`, the
  mode files (`mode-operate.md`, `mode-read.md`, `mode-persuade.md`),
  `operate.md`, `audit.md`, and the refine guides (`shape`, `layout`,
  `typeset`, `colorize`, `clarify`, `harden`, `onboard`, `adapt`, `animate`,
  `polish`, `distill`, `quieter`, `bolder`, `delight`, `overdrive`,
  `optimize`). Kept verbatim so a refresh is a re-copy.
- `mantle/`: Mantle's own files, never overwritten by a refresh.
  - `medium.md`: the rules that win, sent first in every reply. The modes, the
    scope, no network, theme tokens only in a mini app, look once and fix
    once, and how to read Impeccable words Mantle has no tool for
    (`/impeccable polish`, the scripts, DESIGN.md, comps).
  - The task playbooks, adapted from upstream (each says which file and what
    changed): `mini-app.md`, `dashboard.md`, `deck.md`, `landing-page.md`,
    `experience.md`, `new-work.md` (from `new-work.md`, without the
    interactive concept rounds), `critique.md` (from `critique.md`, condensed
    to one reviewer), `audit.md` (the after-build checklist with Mantle's
    picture tools).

## Topics

Every reply is `mantle/medium.md` and then the topic's files. A task topic adds
the craft floor. `design_guide` with no topic lists them with their sizes.

| Topic                                           | Files after the medium                              |
| ----------------------------------------------- | --------------------------------------------------- |
| `mini-app`, `dashboard`, `deck`, `landing-page` | the `mantle/` playbook, `upstream/craft-floor.md`   |
| `new-work`, `critique`, `audit`                 | the `mantle/` file                                  |
| `technical-audit`                               | `upstream/audit.md`                                 |
| `operate`                                       | `upstream/mode-operate.md`, `upstream/operate.md`   |
| `read`, `persuade`                              | the `upstream/mode-*.md` file                       |
| `experience`                                    | `mantle/experience.md`, `upstream/mode-persuade.md` |
| `craft-floor` and the refine names              | the one `upstream/` file                            |

## Not vendored

They need the Impeccable CLI, a browser session it drives, or a native app:
`live.md`, `live-setup.md`, `generate.md`, `hooks.md`, `doctor.md`, `init.md`,
`document.md`, `extract.md`, `foundations.md`, `region-map.md`, `routing.md`,
`component-review.md`, `visualize.md` (image-generated comps), `degraded/*`,
`craft.md` (a deprecated alias), `ios.md`, `android.md` and the `*.native.md`
files. `SKILL.md` is not copied; its modes and core principles are restated in
`mantle/medium.md`.

## Refresh

1. Find the latest `skill-v*` tag on github.com/pbakaus/impeccable and check
   the license is still Apache 2.0 and read NOTICE.md.
2. Re-copy the `upstream/` files above from
   `.claude/skills/impeccable/reference/` at that tag. Read the diff: the text
   is data for builders, so check it says nothing a builder should not do.
3. Update the version and commit here, in `NOTICE.md` and in
   `DESIGN_GUIDE_SOURCE` (the tool). Re-read the `mantle/` playbooks against
   the new upstream text.
4. `pnpm test packages/tools/src/builtins-design-guide.test.ts` checks every
   topic's size and that no file has an em dash.

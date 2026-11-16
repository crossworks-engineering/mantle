# Design guide: the Mantle medium (read first)

These are the design rules for building a mini app or a Present canvas (a deck, dashboard, landing page, poster or explainer). They come from Impeccable (impeccable.style), Apache 2.0. The rules here are Mantle's and win over anything below them.

**Scope.** Only for building apps and presentations; other work does not need this guide. The Mantle interface itself (its screens, settings, panels) keeps its own UI rules; never restyle it from here.

## The mode decides how bold to be

Pick the mode from the surface you are asked to make, not from the product.

- **Operate**: the visitor does a task. Mini apps, dashboards, trackers, forms, admin tools. Clarity, standard controls and real states first; the brand shows in precise details.
- **Read**: the visitor understands something. Reports, explainers, guides. A calm reading column inside a frame that has character.
- **Persuade**: the visitor decides and acts. A landing page, a pitch deck, a poster. Bold, distinct, one clear action.
- **Experience**: the visitor is inside the work. A showcase, a gallery, an interactive piece. The work leads from the first view.

## Mantle overrides

- **No network.** No CDN, no outside fonts, images or stylesheets. Fonts come from the theme (`font-sans`, `font-serif`, `font-mono`); a canvas may also name a face the frame serves (the canvas_authoring skill lists them). Pictures are inline SVG, `data:` URLs or Files (`mantle.media` in a canvas). "Self-host a face" below means: pick from what the frame serves.
- **Colour in a mini app is theme tokens only** (`bg-primary`, `bg-accent`, `bg-card`, `chart-1` to `chart-5` and their `-foreground` pairs). The owner picks the theme, and there are about 40. Commit a colour strategy through the tokens: a region in `bg-primary`, a rail in `bg-accent`, the chart tokens as named roles. Never hex or rgb.
- **A canvas** follows the owner's theme through the same tokens. An Operate or Read canvas stays on tokens. A Persuade or Experience canvas may set its own palette as CSS variables; then set `canvas:theme` to `fixed`, or check the dark theme with `present_render` `theme: 'dark'`.
- **Controls in a mini app** are the kit (`@/components/ui/*`) and `lucide-react` icons. Restyle them with classes; never fake a control from a div.
- **Look once, fix once.** A canvas save returns its picture: look at it, fix every problem in one batch, look again, stop. A mini app is the same with `app_render` after `app_build`; then leave it in draft for the person to review.
- **Real data only.** Numbers and labels come from the request or the brain. Sample data you author is marked as sample. Never invent prices, customers or claims.

## Reading the Impeccable text

The topic text that follows may name things Mantle does not have. Read them this way:

- `/impeccable <name>` means `design_guide` with `topic: '<name>'`.
- Lines that run `impeccable` scripts, the detector, hooks, live mode, `critique-storage` or a finish reviewer: skip them. Do the check yourself by looking at the picture.
- PRODUCT.md, DESIGN.md and surface briefs: there are none. The request, the app or canvas as it is, and this guide are the context.
- A "comp" is a mock-up picture. On Mantle, your first render plays that role.
- "concept-seed", "catalog", "the roll" and "the decision page": choose the direction yourself, as the `new-work` topic says.
- iOS and Android notes: skip them. Mantle builds run in a browser frame.

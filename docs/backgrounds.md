# Generated backgrounds

Four areas of the shell can carry a generated backdrop, drawn from the same
DiceBear catalogue as the avatars and coloured from the live theme ramp.
**Experimental.**

| Area | Surface |
| --- | --- |
| Menu | The left navigation column |
| Header | The bar across the top |
| Chat | Behind the conversation on `/assistant` |
| Activity | The right-hand live column |

Each area is set independently in **Settings → Appearance → Backgrounds**, from
the 16 styles in the `backgrounds` category (see
[avatar-styles.md](avatar-styles.md)) plus **Off**. Only the menu is decorated
out of the box; the rest default to Off, because turning on all four at once is
a decorated app rather than a decorated panel.

## Off is a real choice

`off` is stored, not inferred from absence. Otherwise "I turned the header off"
would be indistinguishable from "I never set the header", and the next change to
a default would silently switch it back on.

## Where it lives

| Concern | Module |
| --- | --- |
| Which styles qualify | `packages/web-ui/src/avatar.ts` (`BACKGROUND_STYLES`) |
| Rendering one at panel size | `packages/web-ui/src/backdrop.ts` |
| Areas, defaults, wire format | `packages/web-ui/src/backgrounds.ts` |
| Per-area presets + the seed | `packages/web-ui/src/area-backdrop.tsx` |
| Live state | `packages/web-ui/src/background-provider.tsx` |
| The picker | `client/web/components/appearance/background-gallery.tsx` |

Storage and delivery mirror the colour theme and the avatar style exactly: a
brain-level preference (`backgrounds`, on the anchor owner's row), written by
`PUT /api/profile/backgrounds`, rendered server-side into
`<html data-backgrounds="menu=waves,header=off">`, and read back by the provider
on mount. No before-paint script, no localStorage. Areas on their default are
omitted from the attribute, so changing a default still reaches brains that
never chose.

## Two things that make it a background rather than a big avatar

1. **Fit.** DiceBear hard-codes `width`/`height` on the root `<svg>` and omits
   `preserveAspectRatio`, so a square composition letterboxes inside a tall
   sidebar. `fitSvg` rewrites that one tag to `slice`, the SVG equivalent of
   `background-size: cover`. It touches only the root, leaving the RDF licence
   block intact.
2. **Upright.** Most of these styles randomise rotation per seed; `waves` picks
   from a full 360°, so roughly half of all seeds hang the sea from the ceiling.
   Where a style offers a `none` rotation variant it is pinned. Animation
   variants are pinned off too; a nav that moves forever is a distraction.

## Legibility is the whole design constraint

These sit behind text, and the ramp is made of CHART colours, chosen to be
distinguishable from each other, which makes them loud. So:

- Opacity is low, and lowest of all for **chat**, the surface people actually
  read.
- **Menu** and **activity** are masked away toward the top, where the labels are
  densest, and the crop is anchored to the bottom where wave crests sit.
- **Header** gets no mask: a gradient across ~48px reads as a smudge. It gets a
  lower opacity instead.

The presets live in one place (`area-backdrop.tsx`) so this is defined once
rather than re-tuned at four call sites.

## The seed is the area name

Every area needs a seed both the shell and the picker agree on, or the four draw
from different points in the ramp and look accidentally mismatched. Keying on
the area id is stable, needs no fetch, gives each area its own character, and
lets a picker swatch preview the exact artwork that area will get.

The consequence: two brains on the same theme get the same backgrounds.
Per-brain variety would mean seeding from the brain's name, which needs the site
name delivered alongside the other appearance attributes.

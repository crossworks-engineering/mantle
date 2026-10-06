# Mantle brand assets

The official Mantle logo files. **This directory is the source of truth.** If
you need the logo for anything (docs, a deck, a favicon, the companion app, a
partner's site), take it from here. Don't export a fresh one, and don't reuse a
copy you found elsewhere in the tree.

## The mark

A round badge with a setting sun: a half sun in a deep rust ring, over three
bands of amber, orange and rust. Beside it, the `mantle` name in custom
script lettering. Redrawn 2026-10-06.

| file | what it is |
|---|---|
| `mantle-logo-icon.svg` | The badge alone (2000x2000). |
| `mantle-logo-full.svg` | Badge and name side by side (1657x395). |
| `mantle-logo-full-stacked.svg` | Badge above the name, stacked (1420x1175). |
| `mantle-text-design.svg` | The name alone (1420x396). |
| `mantle-logo-design.af` | The Affinity design source for all of the above. |

- **SVG is the master.** All four are true vectors with no embedded bitmaps and
  no external references, so they render standalone anywhere. Each file is cut
  tight to its artwork, with no empty space round it. For a raster (a PNG for
  a place that can't take SVG), export it from the SVG at the size you need.
- **`mantle-logo-design.af` is the design source.** Edit the mark there, then
  re-export the files above.

## Which one to use

- **Badge** where the mark has to work small or square: favicons, app icons,
  avatars, social profile images.
- **Badge and name** where there is horizontal room: site navigation, docs
  headers, READMEs, decks.
- **Stacked** where the space is square but the name should still show: a
  footer, a title slide, a sticker.
- **Name alone** next to a large badge that is already on the page, as on the
  site's link-preview image.

The logo sits straight on the background, in both light and dark, with no box
or badge behind it.

## Where it is used

- **mantle-ai.tech** (mantle-site repo): badge and name in the top bar (badge
  alone on phones), stacked logo in the footer, badge as the tab and Apple
  icon, and the name and badge on the link-preview image. The site keeps
  copies in `public/brand/`; when a file here changes, copy it there again.

## Colours

Mantle (the engine) and Jackdaw (the product) share one colour base, and each
keeps its own lead colour. They read as one family, but you can tell them
apart. The site's `app/globals.css` and `DESIGN.md` (mantle-site repo) hold
every token; this is the short version.

| role | hex | used for |
|---|---|---|
| Shared cream | `#FDE7BC` | Cream keys, key legends, night text. Jackdaw's background and wordmark. |
| Shared brown | `#2D1500` | Ink on cream. Jackdaw's text and badge ring. |
| Shared amber | `#EB9F13` | State: the lit lamp, the focus ring, the current page. |
| Mantle lead: panel grey | `#CFD1CD` day, `#1A1917` night | The panel face, the whole page. |
| Mantle lead: blue-grey | `#44698D` key, `#304C67` / `#8FAACB` text | Keys that leave the site; links by day / night. |
| Install key | `#BC390C` | The install key and nothing else. |
| Phosphor | `#A8F291` on `#0F1A13` | Displays only: commands behind scope glass. |

The logo itself is drawn in four warm colours: amber `#EB9F13`, orange
`#E46E08`, rust `#C83C04` (the sun, the lowest band and the name) and deep
rust `#5C1E02` (the ring). Jackdaw's
lead is sunset orange `#E46E08`. In the Mantle UI, orange is never a text
colour.

## Don't

- Don't stretch, rotate, recolour, or add effects to the mark.
- Don't put the logo on a badge, plate or box.
- Don't rebuild the name by setting type. It is custom lettering, not a font.
- Don't re-export a raster from a raster. Always go back to the SVG or the
  Affinity file.

## History

The first logo files left this repo in the jackdaw split (`bf372a311`,
2026-08-13), were deleted from jackdaw as well (`b6395514`, 2026-08-22), and
were restored here from git history. That mark was an `m` in a circle, in black
and in a blue-to-purple gradient. On 2026-10-06 a round three-band badge (a
vertical line with three nodes over the bands) replaced it, and the same day
the setting-sun badge replaced that. The PNG exports and the old
`mantle-logo-full-topdown.svg` were dropped with it. The old files are still
in git history. The Jackdaw marks are a different brand and live in the
jackdaw repo's `brand/`.

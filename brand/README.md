# Mantle brand assets

The official Mantle logo files. **This directory is the source of truth** — if
you need the logo for anything (docs, a deck, a favicon, the companion app, a
partner's site), take it from here rather than exporting a fresh one or reusing
a copy you found elsewhere in the tree.

## The files

Two lockups, each in a mono and a colour variant, each as SVG and PNG:

| file | what it is |
|---|---|
| `mantle-logo-icon.svg` / `.png` | Icon (the `m` in a filled circle), solid black |
| `mantle-logo-icon-color.svg` / `.png` | Icon, blue gradient circle with a white `m` |
| `mantle-logo-full.svg` / `.png` | Full wordmark (`mantle`), solid black |
| `mantle-logo-full-color.svg` / `.png` | Full wordmark, blue-to-purple gradient |

- **SVG is the master.** Scale it, recolour the mono version, or export a new
  raster size from it. All four are true vectors — no embedded bitmaps and no
  external references, so they render standalone anywhere.
- **`mantle-logo-design.af` is the design source.** It is the Affinity file the
  SVGs and PNGs were exported from. Edit the mark there, then re-export the
  eight files above.
- **PNG is a convenience export** for places that can't take SVG. Both are RGBA
  with a transparent background: icon at 2000x2000, wordmark at 1400x400.

## Colours

Mantle (the engine) and Jackdaw (the product) share one colour base and
each keeps its own lead colour, so they read as one family but you can tell
them apart. The site's `app/globals.css` and `DESIGN.md` (mantle-site repo)
hold every token; this is the short version.

| role | hex | used for |
|---|---|---|
| Shared cream | `#FDE7BC` | Cream keys, key legends, night text, the nameplate wordmark. Jackdaw's background and wordmark. |
| Shared brown | `#2D1500` | Ink on cream. Jackdaw's text and badge ring. |
| Shared amber | `#EB9F13` | State: the lit lamp, the focus ring, the current page. |
| Mantle lead: panel grey | `#CFD1CD` day, `#1A1917` night | The panel face, the whole page. |
| Mantle lead: blue-grey | `#44698D` key, `#304C67` / `#8FAACB` text | Keys that leave the site; links by day / night. |
| Install key | `#BC390C` | The install key and nothing else. |
| Phosphor | `#A8F291` on `#0F1A13` | Displays only: commands behind scope glass. |

Jackdaw's lead is sunset orange `#E46E08`. Orange is never a Mantle text
colour. The logo files above predate this palette; a new mark is being
drawn separately and will take these colours.

## Which one to use

- **Icon** where the mark has to work small or square: favicons, app icons,
  avatars, social profile images.
- **Full wordmark** where there's horizontal room and the name should be
  readable: docs headers, READMEs, decks, site navigation.
- **Colour** on light or neutral backgrounds, when the brand should carry the
  moment.
- **Mono** when it must sit on a busy or coloured background, when it's being
  printed in one colour, or when it needs to be recoloured to match a theme.
  The mono files are solid black — recolour by setting `fill` on the SVG.

## Don't

- Don't stretch, rotate, recolour the gradient, or add effects to the mark.
- Don't rebuild the wordmark by setting type — it's custom lettering, not a font.
- Don't re-export a raster from a raster. Always go back to the SVG.

## History

These files left this repo in the jackdaw split (`bf372a311`, 2026-08-13) and
were then deleted from jackdaw as well (`b6395514`, 2026-08-22), which left no
canonical copy in any repo. They were restored here unchanged from git history.
The Jackdaw marks are a different brand and live in the jackdaw repo's `brand/`.

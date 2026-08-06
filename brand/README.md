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
- **PNG is a convenience export** for places that can't take SVG. Both are RGBA
  with a transparent background: icon at 2000x2000, wordmark at 1400x400.

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

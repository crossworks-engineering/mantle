# MantleOS brand assets

The official MantleOS marks. **This directory is the source of truth.** If you
need a mark for anything (docs, a deck, a favicon, the apps, a partner's site),
take it from here. Don't export a fresh one, and don't reuse a copy you found
elsewhere.

Since 2026-10-17 there is one brand, MantleOS. The engine was called Mantle and
the app Jackdaw; both are now MantleOS, and the desktop app is MantleOS
Desktop. Engine names in code stay as they are (`MANTLE_*`, `@mantle/*`,
`mantle_*` containers).

## The marks

| file | what it is | use it |
|---|---|---|
| `mantle-sun-icon.svg` | The icon: a round badge with a setting sun (2000x2000). | Favicons, app icons, avatars, anywhere the name will not fit. |
| `mantle-logo-os.svg` | The mantleOS wordmark: script "mantle" and an "OS" tag (1829x441). | The default wherever there is horizontal room: site and docs headers, READMEs, decks. |
| `mantle-logo-os-sun-icon.svg` | Icon and wordmark in one square (2000x2000). | Only an occasional big square placement. Never small. |
| `mantle-logo-design.af` | The Affinity design source for all of the above. | Edit the marks here, then re-export. |

- **SVG is the master.** All three are true vectors with the text converted to
  curves, no embedded bitmaps and no external references, so they render the
  same anywhere. For a raster, export it from the SVG at the size you need.
- One file per mark, not a light and dark pair: the art reads on cream and on
  brown alike. It sits straight on the background, with no plate or box behind
  it. An icon that needs a square background puts the sun on brand cream
  `#FDE7BC`.

## Where it is used

- **docs.mantleos.io** (`docs-site/`): the wordmark in the header and the icon
  as the favicon, copied here at build by `docs-site/scripts/sync-brand.mjs`.
- **mantleos.io** (mantle-site repo) and the **jackdaw** repo (MantleOS web,
  Desktop and mobile) keep copies with the Affinity ids stripped. When a file
  here changes, copy it there again.

## Colours

The marks are drawn in six colours:

| hex | where |
|---|---|
| `#2D1500` brand brown | Ink on cream. |
| `#FDE7BC` brand cream | The "OS" letters, and the icon background where one is needed. |
| `#EB9F13` amber | The sun's top band. |
| `#E46E08` sunset orange | The middle band. |
| `#C83C04` rust | The sun, the bottom band, the "mantle" script and the OS tag. |
| `#5C1E02` deep rust | The badge's rim. |

## Don't

- Don't use the stacked logo small.
- Don't stretch, rotate, recolour, or add effects to the marks.
- Don't put a mark on a badge, plate or box.
- Don't rebuild the wordmark by setting type. It is custom lettering, not a
  font.
- Don't re-export a raster from a raster. Always go back to the SVG or the
  Affinity file.

## History

The first logo files left this repo in the jackdaw split (`bf372a311`,
2026-08-13) and were restored here from git history. That mark was an `m` in a
circle. On 2026-10-06 a setting-sun badge with the `mantle` name in script
replaced it (`mantle-logo-icon.svg`, `mantle-logo-full.svg`,
`mantle-logo-full-stacked.svg`, `mantle-text-design.svg`). On 2026-10-17 the
MantleOS marks above replaced those. The old files are still in git history.

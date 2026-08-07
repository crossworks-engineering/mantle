# Avatar styles: credits and licences

Mantle's generated avatars come from [DiceBear](https://www.dicebear.com)
(`@dicebear/core` + `@dicebear/styles`, both MIT). The **styles themselves are
separately licensed by their designers**, and this file is the credit list
those licences ask for.

This matters because the repo is public and ships these styles. The registry in
[`packages/web-ui/src/avatar.ts`](../packages/web-ui/src/avatar.ts) carries each
style's creator and licence, `avatar.test.ts` checks that table against the
installed package (so a version bump cannot silently restate a licence), and the
style picker in Settings → Appearance shows the credit at the point of choice.
DiceBear also embeds an RDF credit block inside every generated SVG, which we
leave intact.

**CC BY 4.0 requires attribution.** If you fork Mantle and ship it, keep this
file, keep the in-SVG metadata, or drop those styles from the registry.

## Two galleries: avatars and backgrounds

The catalogue is split by **what a style is for**, not by how it looks. The old
shelves (Minimalist / Characters / Scenes) described the artwork but not the
job, and the same generator now draws both 32px avatars and full-panel
backgrounds (see [backgrounds.md](backgrounds.md)):

| Category        | What it is                                                        | Count |
| --------------- | ----------------------------------------------------------------- | ----- |
| **Avatars**     | Portraits and identity marks. One per entity, told apart by seed. | 34    |
| **Backgrounds** | Abstract compositions and scenes that read at panel size.         | 16    |

`initials`, `initial-face`, `glyphs` and `icons` sit under **Avatars** despite
being minimal: they encode an identity, which is an avatar's whole job and
meaningless spread across a sidebar. Everything that was a "scene" is a
background.

A style renders the same whichever gallery it is in, the split governs what
each picker OFFERS, not what `renderAvatarSvg` will draw. That is why a brain
that chose `shapes` as its avatar style before the split keeps it, and why the
avatar picker still shows that choice rather than appearing to have lost it.

## How a brain picks one

Settings → Appearance. The choice is **brain-level**, not per user: one style
and one tint for every generated avatar in the brain, with the per-entity SEED
doing the work of telling agents apart. Six unrelated styles on one screen just
read as noise.

The default avatar style is **Thumbs**. It was `shapes` until that became a
background; nothing was migrated, so only brains that never chose one moved.

**Tint** decides how much of the colour theme the avatars take on:

| Tint                | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| Original            | The style's own palette, untouched. Loudest, ignores the theme.     |
| **Mixed** (default) | The theme tints the BACKGROUND; the artwork keeps its own colours.  |
| Theme               | The theme ramp is pushed into every colour group the style exposes. |

Two things worth knowing about **Theme**: the character styles declare no
colour groups at all, so for them it is identical to Mixed; and groups declared
`contrastTo` another group, `initials`' text, the `icons` glyph, `thumbs`' eyes
and mouth, are deliberately left alone. Those are the legible part drawn on top
of another colour, and painting them from the same five-colour ramp as the
surface behind them is a coin-flip on whether the avatar still has a face.

Style JSON is fetched on demand, one chunk per style: all 50 are 2.47 MB, and an
avatar renders in the app shell on every screen. A brain pays for the one style
it uses; the picker is the only page that loads more.

## By licence

### CC0 1.0: no attribution required

<https://creativecommons.org/publicdomain/zero/1.0/>

| Style              | Designer        | id                   | Category    |
| ------------------ | --------------- | -------------------- | ----------- |
| Blobs              | DiceBear        | `blobs`              | Backgrounds |
| Clay               | DiceBear        | `clay`               | Avatars     |
| Constellation      | DiceBear        | `constellation`      | Backgrounds |
| Critters           | DiceBear        | `critters`           | Avatars     |
| Disco              | DiceBear        | `disco`              | Backgrounds |
| Glass              | DiceBear        | `glass`              | Backgrounds |
| Identicon          | DiceBear        | `identicon`          | Backgrounds |
| Initial Face       | DiceBear        | `initial-face`       | Avatars     |
| Initials           | DiceBear        | `initials`           | Avatars     |
| Landscape          | DiceBear        | `landscape`          | Backgrounds |
| Loops              | DiceBear        | `loops`              | Backgrounds |
| Lorelei            | Lisa Wischofsky | `lorelei`            | Avatars     |
| Lorelei Neutral    | Lisa Wischofsky | `lorelei-neutral`    | Avatars     |
| Moods              | DiceBear        | `moods`              | Avatars     |
| Notionists         | Zoish           | `notionists`         | Avatars     |
| Notionists Neutral | Zoish           | `notionists-neutral` | Avatars     |
| Open Peeps         | Pablo Stanley   | `open-peeps`         | Avatars     |
| Pixel Art          | DiceBear        | `pixel-art`          | Avatars     |
| Pixel Art Neutral  | DiceBear        | `pixel-art-neutral`  | Avatars     |
| Pixelbot           | DiceBear        | `pixelbot`           | Avatars     |
| Planets            | DiceBear        | `planets`            | Backgrounds |
| Rings              | DiceBear        | `rings`              | Backgrounds |
| Shape Grid         | DiceBear        | `shape-grid`         | Backgrounds |
| Shapes             | DiceBear        | `shapes`             | Backgrounds |
| Sprouts            | DiceBear        | `sprouts`            | Avatars     |
| Squircles          | DiceBear        | `squircles`          | Backgrounds |
| Stripes            | DiceBear        | `stripes`            | Backgrounds |
| Thumbs             | DiceBear        | `thumbs`             | Avatars     |
| Triangles          | DiceBear        | `triangles`          | Backgrounds |
| Waves              | DiceBear        | `waves`              | Backgrounds |
| Weave              | DiceBear        | `weave`              | Backgrounds |

### MIT: no attribution required

<https://opensource.org/licenses/MIT>

| Style | Designer              | id      | Category |
| ----- | --------------------- | ------- | -------- |
| Icons | The Bootstrap Authors | `icons` | Avatars  |

### CC BY 4.0: **attribution required**

<https://creativecommons.org/licenses/by/4.0/>

| Style              | Designer                | id                   | Category |
| ------------------ | ----------------------- | -------------------- | -------- |
| Adventurer         | Lisa Wischofsky         | `adventurer`         | Avatars  |
| Adventurer Neutral | Lisa Wischofsky         | `adventurer-neutral` | Avatars  |
| Big Ears           | The Visual Team         | `big-ears`           | Avatars  |
| Big Ears Neutral   | The Visual Team         | `big-ears-neutral`   | Avatars  |
| Big Smile          | Ashley Seo              | `big-smile`          | Avatars  |
| Croodles           | vijay verma             | `croodles`           | Avatars  |
| Croodles Neutral   | vijay verma             | `croodles-neutral`   | Avatars  |
| Dylan              | Natalia Spivak          | `dylan`              | Avatars  |
| Fun Emoji          | Davis Uche              | `fun-emoji`          | Avatars  |
| Glyphs             | Matt Houser             | `glyphs`             | Avatars  |
| Micah              | Micah Lanier            | `micah`              | Avatars  |
| Miniavs            | Webpixels               | `miniavs`            | Avatars  |
| Personas           | Draftbit - draftbit.com | `personas`           | Avatars  |
| Toon Head          | Johan Melin             | `toon-head`          | Avatars  |

### Free for personal and commercial use: **attribution required**

| Style             | Designer      | id                  | Category |
| ----------------- | ------------- | ------------------- | -------- |
| Avataaars         | Pablo Stanley | `avataaars`         | Avatars  |
| Avataaars Neutral | Pablo Stanley | `avataaars-neutral` | Avatars  |
| Bottts            | Pablo Stanley | `bottts`            | Avatars  |
| Bottts Neutral    | Pablo Stanley | `bottts-neutral`    | Avatars  |

---

50 styles in total: 31 × CC0 1.0, 1 × MIT, 14 × CC BY 4.0, 4 × Free for personal and commercial use.

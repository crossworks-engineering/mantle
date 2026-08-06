# Avatar styles — credits and licences

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

## How a brain picks one

Settings → Appearance. The choice is **brain-level**, not per user: one style
and one tint for every generated avatar in the brain, with the per-entity SEED
doing the work of telling agents apart. Six unrelated styles on one screen just
read as noise.

**Tint** decides how much of the colour theme the avatars take on:

| Tint | What it does |
| --- | --- |
| Original | The style's own palette, untouched. Loudest, ignores the theme. |
| **Mixed** (default) | The theme tints the BACKGROUND; the artwork keeps its own colours. |
| Theme | The theme ramp is pushed into every colour group the style exposes. |

Two things worth knowing about **Theme**: the character styles declare no
colour groups at all, so for them it is identical to Mixed; and groups declared
`contrastTo` another group — `initials`' text, the `icons` glyph, `thumbs`' eyes
and mouth — are deliberately left alone. Those are the legible part drawn on top
of another colour, and painting them from the same five-colour ramp as the
surface behind them is a coin-flip on whether the avatar still has a face.

Style JSON is fetched on demand, one chunk per style: all 50 are 2.47 MB, and an
avatar renders in the app shell on every screen. A brain pays for the one style
it uses; the picker is the only page that loads more.

## By licence

### CC0 1.0 — no attribution required

<https://creativecommons.org/publicdomain/zero/1.0/>

| Style              | Designer        | id                   | Category   |
| ------------------ | --------------- | -------------------- | ---------- |
| Blobs              | DiceBear        | `blobs`              | Minimalist |
| Clay               | DiceBear        | `clay`               | Characters |
| Constellation      | DiceBear        | `constellation`      | Scenes     |
| Critters           | DiceBear        | `critters`           | Characters |
| Disco              | DiceBear        | `disco`              | Minimalist |
| Glass              | DiceBear        | `glass`              | Minimalist |
| Identicon          | DiceBear        | `identicon`          | Minimalist |
| Initial Face       | DiceBear        | `initial-face`       | Minimalist |
| Initials           | DiceBear        | `initials`           | Minimalist |
| Landscape          | DiceBear        | `landscape`          | Scenes     |
| Loops              | DiceBear        | `loops`              | Minimalist |
| Lorelei            | Lisa Wischofsky | `lorelei`            | Characters |
| Lorelei Neutral    | Lisa Wischofsky | `lorelei-neutral`    | Characters |
| Moods              | DiceBear        | `moods`              | Characters |
| Notionists         | Zoish           | `notionists`         | Characters |
| Notionists Neutral | Zoish           | `notionists-neutral` | Characters |
| Open Peeps         | Pablo Stanley   | `open-peeps`         | Characters |
| Pixel Art          | DiceBear        | `pixel-art`          | Characters |
| Pixel Art Neutral  | DiceBear        | `pixel-art-neutral`  | Characters |
| Pixelbot           | DiceBear        | `pixelbot`           | Characters |
| Planets            | DiceBear        | `planets`            | Scenes     |
| Rings              | DiceBear        | `rings`              | Minimalist |
| Shape Grid         | DiceBear        | `shape-grid`         | Minimalist |
| Shapes             | DiceBear        | `shapes`             | Minimalist |
| Sprouts            | DiceBear        | `sprouts`            | Characters |
| Squircles          | DiceBear        | `squircles`          | Minimalist |
| Stripes            | DiceBear        | `stripes`            | Minimalist |
| Thumbs             | DiceBear        | `thumbs`             | Characters |
| Triangles          | DiceBear        | `triangles`          | Minimalist |
| Waves              | DiceBear        | `waves`              | Minimalist |
| Weave              | DiceBear        | `weave`              | Minimalist |

### MIT — no attribution required

<https://opensource.org/licenses/MIT>

| Style | Designer              | id      | Category   |
| ----- | --------------------- | ------- | ---------- |
| Icons | The Bootstrap Authors | `icons` | Minimalist |

### CC BY 4.0 — **attribution required**

<https://creativecommons.org/licenses/by/4.0/>

| Style              | Designer                | id                   | Category   |
| ------------------ | ----------------------- | -------------------- | ---------- |
| Adventurer         | Lisa Wischofsky         | `adventurer`         | Characters |
| Adventurer Neutral | Lisa Wischofsky         | `adventurer-neutral` | Characters |
| Big Ears           | The Visual Team         | `big-ears`           | Characters |
| Big Ears Neutral   | The Visual Team         | `big-ears-neutral`   | Characters |
| Big Smile          | Ashley Seo              | `big-smile`          | Characters |
| Croodles           | vijay verma             | `croodles`           | Characters |
| Croodles Neutral   | vijay verma             | `croodles-neutral`   | Characters |
| Dylan              | Natalia Spivak          | `dylan`              | Characters |
| Fun Emoji          | Davis Uche              | `fun-emoji`          | Characters |
| Glyphs             | Matt Houser             | `glyphs`             | Minimalist |
| Micah              | Micah Lanier            | `micah`              | Characters |
| Miniavs            | Webpixels               | `miniavs`            | Characters |
| Personas           | Draftbit - draftbit.com | `personas`           | Characters |
| Toon Head          | Johan Melin             | `toon-head`          | Characters |

### Free for personal and commercial use — **attribution required**

| Style             | Designer      | id                  | Category   |
| ----------------- | ------------- | ------------------- | ---------- |
| Avataaars         | Pablo Stanley | `avataaars`         | Characters |
| Avataaars Neutral | Pablo Stanley | `avataaars-neutral` | Characters |
| Bottts            | Pablo Stanley | `bottts`            | Characters |
| Bottts Neutral    | Pablo Stanley | `bottts-neutral`    | Characters |

---

50 styles in total: 31 × CC0 1.0, 1 × MIT, 14 × CC BY 4.0, 4 × Free for personal and commercial use.

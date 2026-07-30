// One page that exercises EVERY construct the Pages editor supports, so the
// demo has somewhere to point when the question is "what can a page actually
// do?" — rather than answering it with fifty ordinary pages.
//
// It is written as the studio's own document style guide, not as a feature
// list: a demo screen that looks like a real document a team would keep is
// worth more than a swatch sheet, and it still shows every construct.
//
// The body is the rich-markdown dialect (docs/rich-writing.md), converted by
// the app's own markdownToDoc at seed time — so if a construct here renders
// wrong, that is a real defect in the converter or the editor schema, which is
// exactly what a showcase should surface.
//
// Deliberately NOT covered: mention, childPage and fileEmbed. All three need a
// real node id to point at, and a showcase that fabricates ids would render
// broken cards. They are called out in the page text instead of faked.
import { owner } from '../lib/world.mjs';

export function generate(rngRoot) {
  const rng = rngRoot.fork('showcase');
  const nodes = [];

  // `# title` in the BODY: a page's name is not its heading, and the renderer
  // does not promote one to the other.
  const body = `# Document style guide

How we write things down at the studio. Everything below is a construct the
editor supports — if you can see it here, you can use it in your own pages.

## Text

Body copy carries **bold**, *italic*, ~~struck~~ and \`inline code\`. Links look
like [the handbook](https://example.com/handbook). Use ==highlight== for the
line a reader must not miss, and [themed colour]{color=chart-2} or
[a tinted run]{highlight=chart-3} when a document needs a second voice without
shouting.

> Write the note you would want to find in eighteen months, on a Friday, with
> the site radio going. That is the whole standard.

## Structure

Three heading levels, and no more. A fourth means the page wants splitting.

### Lists

- Survey the loop before touching a terminal
- Photograph the panel *before* the change, not after
  - Wide shot for context
  - Close shot for the label
- Leave the tag on the cable

1. Isolate
2. Prove dead
3. Work
4. Restore and re-prove

### Checklists

- [x] Loop schedule printed
- [x] Calibrator certificate in date
- [ ] Client contact confirmed on site
- [ ] Permit signed

## Callouts

The four variants carry different weight. Reach for the strongest one honestly —
a page where everything is a warning teaches people to skip warnings.

:::info
Loop numbers follow the P&ID, never the panel label. The panel is wrong more
often than the drawing is.
:::

:::success
Signed-off procedures live under the procedures branch and supersede their
predecessor automatically. You do not need to delete the old revision.
:::

:::warning
A calibration outside its certificate window invalidates every reading taken
with it, including the ones that looked fine.
:::

:::danger
Never prove dead with an instrument you have not proved live first, then live
again afterwards. Two proves, one instrument, every time.
:::

## Asides

:::aside chart-4
Asides hold the useful digression — the reason behind a rule, the story that
makes it stick — without breaking the spine of the document.
:::

## Columns

:::columns
**Before the visit**

Confirm access, permits and the site contact. Check the calibrator certificate
and print the loop schedule.
+++
**After the visit**

Upload photographs the same day, close the snags you cleared, and raise the ones
you could not.
:::

## Tables

| Instrument | Range | Last calibrated | In date |
| --- | --- | --- | --- |
| Loop calibrator A | 4–20 mA | 2026-05-14 | yes |
| Loop calibrator B | 4–20 mA | 2025-11-02 | no |
| Pressure module | 0–10 bar | 2026-03-30 | yes |

## Code

Syntax highlighting covers the languages we actually use.

\`\`\`python
def scale(raw_ma, lo=0.0, hi=10.0):
    """4-20 mA to engineering units, clamped."""
    span = (raw_ma - 4.0) / 16.0
    return max(lo, min(hi, lo + span * (hi - lo)))
\`\`\`

## Diagrams

Mermaid blocks render as diagrams, so a flow can live beside the words that
explain it instead of in a screenshot that goes stale.

\`\`\`mermaid
flowchart LR
  A[Site visit] --> B{Loop reads true?}
  B -- yes --> C[Sign off]
  B -- no --> D[Raise snag]
  D --> E[Re-test on next visit]
  E --> B
\`\`\`

## Maths

Inline, for a value in a sentence: the span conversion is $y = (x - 4)/16$.

And as a block, when the expression is the point:

$$
y = y_{\\min} + \\frac{x - 4}{16}\\,(y_{\\max} - y_{\\min})
$$

---

## Also available

Three constructs are not shown above because each needs to point at something
real: **mentions** of another node, **sub-page cards**, and **file embeds**. They
appear throughout the rest of this brain, on the pages that actually reference
something.
`;

  nodes.push({
    id: 'studio-style-guide',
    kind: 'page',
    branch: 'studio.handbook',
    title: 'Document style guide',
    body,
    // Recent, so it sits near the top of a date-sorted list where a visitor
    // will actually find it.
    offset: -3 - rng.int(0, 2),
    tags: ['handbook', 'reference'],
    meta: {},
  });

  return { nodes };
}

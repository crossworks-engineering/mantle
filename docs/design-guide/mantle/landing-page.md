# Task: a landing page or poster

Adapted for Mantle from Impeccable v4.9.1 `reference/mode-persuade.md` and `reference/new-work.md` (Apache 2.0). Changed: condensed for a Present canvas or a shared mini app.

A landing page, campaign page, pricing page or poster is a **Persuade** surface: the design is what the visitor judges. In Mantle it is usually a Present canvas (`canvas:size` `fill` for a page that scrolls, a fixed size for a poster). Read `persuade` for more depth.

## The opening must do three things

1. Make the offer clear and wanted in one line.
2. Show a clear action, in its working form: the form, the booking, the sign-up itself, not a link to it elsewhere. A canvas has no network: its form saves with `mantle.data`, never a form that submits nowhere.
3. Prove something only this product can: the thing at work, a real number, a real example.

## The world carries the page

- Find the world as `new-work` says. Take the bolder colour strategies (Committed or Drenched) when the brief allows; set the palette as CSS variables and `canvas:theme` `fixed`.
- The world's material is the ground and the major surfaces; its type sets the headlines. A world reduced to one accent on a neutral template is the category default with a sticker on it.
- The world is the carrier, never a picture of the page: navigation still reads as links, copy as text, the action as plainly clickable, and the next section starts as a section.
- If the world is an object (a book, a ticket, a shop front), the page is that one object at one scale, keeping its real form.

## The rut to avoid

- The split hero (copy on one side, product picture on the other, a badge row below).
- A centred headline over subcopy and a button, then a row of equal cards.
- The calibration looks in `new-work` (cream and serif, neon on black, editorial hairlines, hard offset shadows) when the brief did not ask for them.
- A kicker above the heading. Gradient text. Glass. Decorative blobs.

## Build

- Face with a point of view, from what the frame serves. Display text up to 6rem; body at a real measure.
- Pace the scroll: vary density, scale and quiet inside one grammar; end on a real close with the action again.
- Motion once, authored: one moment that matters, content visible by default, reduced motion honoured.
- Real content. Invented prices, customers, logos or quotes are never allowed; sample material is labelled sample.

## Check

Render at desktop width and at a phone width (`present_render` `width`/`height` on a `fill` canvas). Fix everything in one batch, look again, stop. Then run the `audit` checklist once.

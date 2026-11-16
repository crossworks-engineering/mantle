# Task: a mini app

Adapted for Mantle from Impeccable v4.9.1 `reference/mode-operate.md` and `reference/operate.md` (Apache 2.0). Changed: condensed, and set in the mini-app frame (kit, theme tokens, `host.db`).

A mini app is an **Operate** surface: the person came to get a job done. Build a working product of its category first; the look serves it. For more depth read the `operate` topic.

## Before you write code

- Name the task, the data, how often it is used, and the states that matter (empty, loading, error, a long list, a bad input).
- Name one **signature move**: a concrete idea that makes this app its own, such as a schedule set in a timetable's column rhythm, or stock levels drawn as a shelf. A look that is only a colour scheme has not found its move.
- The world lends four things only: type, palette (through the tokens), density and that one move. It never supplies the layout, navigation or controls.

## The shell

- Write the first view as the product's shell: where navigation lives, each work area and what it is for, what the person reads first.
- Standard controls the person already knows: the kit's Button, Input, Card, Badge, tabs, tables with sortable headers. Never a costume (a fake terminal prompt, a bezel, ruled ledger paper standing in for a table).
- A dashboard fills the frame (`h-dvh`, scroll areas with `min-h-0` and `overflow-y-auto`). A small form is a centred column (`mx-auto max-w-md p-4`).
- Responsive by structure: collapse the side rail, stack columns, let tables scroll. Not fluid type.

## Type and colour

- One family is often right: the theme's `font-sans` carries headings, labels, body and data. Fixed rem steps at about 1.125 to 1.2. Tabular numbers in data (`tabular-nums`).
- Restrained is the floor; one region may earn Committed (a header or rail in `bg-primary`). The accent marks primary actions, selection and state only, never decoration.
- A second neutral layer (`bg-muted`, `bg-card`) for side rails, toolbars and panels.
- State colours (`destructive` for critical) appear only where they carry meaning.

## States: ship all of them

- Every control: default, hover, focus, active, disabled, loading, error.
- Loading: `<Loading label="..."/>` in the part that waits, never full screen, never a spinner over content.
- Empty states teach: say what goes here and give the action that fills it.
- Errors name the problem and the way out, in the product's words.
- Overlays escape their container: a dropdown inside `overflow: hidden` gets clipped.

## Motion

150 to 250 ms, and only to show a change of state. No load-in choreography: the app opens into the task.

## Never

- The hero-metric template (big number, small label, a row of stat tiles) as the whole app.
- Same-size cards of icon plus heading plus text as the page structure. Nested cards.
- A modal for a task that needs no interruption.
- Display fonts in labels, buttons or data. Emoji as icons (use `lucide-react`).
- Hex or rgb colours. A colored `border-left` stripe on cards or alerts.

## Done when

Someone who uses tools like this would know where everything is in a few seconds; every state above exists; and with the name covered it still reads as this app, not any app. Run the `audit` checklist once, then leave it in draft for the person to review.

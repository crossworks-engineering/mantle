# New work: from request to committed direction

Adapted for Mantle from Impeccable v4.9.1 `reference/new-work.md` (Apache 2.0). Changed: the interactive steps (concept-seed, the decision page, comps, the finish reviewer, DESIGN.md) are replaced by one builder working alone; the rules on worlds, colour, type and finish are kept.

## 1. Decide what is already true

- **Extending something** (a new tab in an app, one more slide): inherit its look and layout. Solve only the new content, states and how it joins. No new identity.
- **A new surface in an existing look** (a second app for the same team, a deck in the house style): keep the look; design the structure from the content and the task.
- **No look yet**: create one (step 3).
- **A redesign**: keep the content, function and facts; replace the old look, do not polish it.

## 2. Know the job before the look

If the request leaves it open, ask one short question; otherwise infer and say what you assumed.

- **Operate:** the task, the data, the important states, how often it is used.
- **Read:** the reader's question, the source material, the order.
- **Persuade:** who must act, what they must believe, which real proof earns it.
- **Experience:** what leads, how exploring unfolds, which transition matters.

Never ask for CSS values or a style lane.

## 3. Find the world (no look yet)

1. Name the product's unique mechanism in one sentence, the audience's real scene, and what this first surface must prove. Name the page this category always ships and its predictable opposite: both are the rut.
2. From the audience's own culture, list seven concrete visual systems, artifacts, places or rituals they know by heart (their publications, notation, signage, data graphics, objects). For each: why it fits, its ground and main colours, its type voices, its one signature. On an Operate or Read surface, never take the tools the audience operates (a terminal, a control panel): they come back as a costume.
3. Pick the strongest. Write the direction in five lines: the world, the first view, the visitor's path, the one signature move, the honest risk.
4. On Operate and Read, the world lends only four things: type, palette, density and one signature move. Layout, navigation and controls stay standard.

## 4. Commit the world

- **Colour strategy before colours.** Restrained (tinted neutrals plus one accent), Committed (one strong colour carries 30 to 60 percent of the surface), Full palette (3 or 4 named roles), or Drenched (the surface is the colour). Persuade and Experience may take the bolder ones. Colour commits at page scale: whole regions, not accents sprinkled on grey. In a mini app, do this with the theme tokens.
- **Light or dark** is never a default: write one sentence on who uses it, where, under what light, and let that decide. In Mantle the owner's theme usually decides; design so both read well.
- **Type.** Operate and Read are well served by the theme's sans and a workhorse face. Persuade and Experience want a face with a point of view, chosen from what the frame serves.
- **Calibration.** Generated interfaces cluster in a few looks: cream ground with a high-contrast serif and a terracotta accent; near-black with one neon accent and glowing edges; editorial hairlines with italic serif and tiny tracked mono labels; flat saturated ink with black boxes and hard offset shadows. Each is fine when the brief asks for it. If the brief left the look free and you landed in one, or someone could guess your look from the category alone, rework it.

## 5. Build with full commitment

- **The first view is a thesis, not a header.** Show the mechanism at once. The memory test: what would someone describe an hour after one look? If the answer is a mood, it has not committed yet.
- **Prove, don't claim.** Show the thing doing its job with specifics a rival could not copy. Sample data is design material: make it realistic and label it sample.
- **Author the content; never substitute chrome.** Names, entries, copy and figures carry a surface. Gradients, glass and generic icon tiles where real content belongs are a gap.
- **Commit every part.** Buttons, inputs, tabs and links follow the world's type and colour; a stock component left unstyled in a committed world is a lapse.
- **One rhythm.** Vary density and scale inside one grammar; more space above a heading than below it; end on a real close.
- **Motion once, orchestrated**, never scattered hover effects. Content is visible by default; honour reduced motion.

Keep semantics, keyboard access, contrast and working behaviour. Then read `craft-floor` (it comes with every task topic) and build.

## 6. Inspect and finish

Look at the result at the sizes it ships at, in one batched round: every slide, both themes, and the states (empty, loading, error, long content). Fix everything that round shows in one batch, look once more, and stop. Two rounds is the ceiling. Report what you made and anything you could not get right.

# The demo's illustrations: how they were made

Twenty square illustrations, generated on 2026-10-07 with the OpenRouter model
`google/gemini-3.1-flash-image` at about 0.07 USD each (1.43 USD for the set,
one image regenerated). Each request carried one print from the jackdaw.run
site as a **style reference only**, so the demo matches the site's look. The
reference image itself is not in this repo and was never uploaded as content.

The JPEGs in this folder are the content. Image generation is not
deterministic, so the generator ships these bytes (`renderFile`, kind
`image`) rather than calling a model. To change an image: generate a new one
with the same base prompt, convert it to JPEG (quality 84), replace the file,
and keep `art.json` in step.

## Base prompt

> Using the attached image ONLY as a style reference (do not copy its subject
> or its bird pose), draw a new illustration in exactly that style: engraved
> screen-print, 1970s catalogue, cream paper stock with fine grain, flat inks
> in the same sunset palette (butter yellow, ochre, orange, rust, dark brown),
> bold dark-brown engraved linework with hatching, a horizontal stripe band of
> the inks behind or around the subject. Square composition. No text, no
> lettering, no numbers, no logos, no brand names, no people or faces.
> Subject: ...

## Subjects

| file | subject |
| --- | --- |
| ps3-station | a small brick municipal water pump station with a flat roof, a slim radio mast, a steel door, a louvred vent and a low fence |
| ps3-pump-hall | the interior of a small pump hall: two large centrifugal pumps with electric motors on concrete plinths, flanged pipework and valves, an overhead crane rail, a jackdaw perched on the crane rail looking down |
| ps3-rtu-cabinet | an open steel telemetry cabinet on a wall: rows of terminal strips, input and output cards, neatly bundled and tagged cables, a small radio modem, a clipboard hanging on the open door |
| ps3-radio-mast | a slim lattice radio mast with a yagi antenna on top of a flat roof, a jackdaw perched on the very top of the mast, a few clouds |
| ps3-valve-chamber | looking down into a square concrete valve chamber: a large gate valve with a handwheel and an electric actuator, a steel access ladder on one wall, a pipe running through |
| ps3-control-room | a utility control room desk with three old monitors showing a simple mimic diagram of pumps, pipes and a tank as plain shapes, a desk telephone, a mug, an empty office chair, no readable text |
| loop-check-kit | a flat lay on a wooden workbench: a handheld loop calibrator with coiled test leads, a multimeter, two screwdrivers, a bundle of cable tags, an open notebook with sketches, a hard hat |
| ps3-standby-generator | an old diesel standby generator on a steel skid inside a shed, a tall exhaust pipe through the roof, a fuel day tank, a control panel with dials |
| island-solar-canopy | a row of solar panels on a steel canopy beside a small brick pump station, low sun, long shadows, a fence |
| island-battery-container | a battery storage container like a shipping container with louvred vents and a cable trench, next to a pad-mounted transformer, gravel yard, fence |
| island-switchboard | a main electrical switchboard with an automatic transfer switch: large rotary isolator handles, indicator lamps, meters with needles, a door open showing busbars |
| island-storm-night | the small brick pump station at night in a heavy rain storm, wind bent trees, power lines down in the distance, the station window still lit warm orange, dark night palette with the same inks |
| reservoir-tower | a round concrete water reservoir on a hill with a steel access stair, a buried pipeline route running down the slope toward a small pump station in the valley |
| harbour-labs-studio | a small design studio interior: drawing board, desk lamp, rolled drawings, mug, plant, a window onto harbour cranes, a jackdaw on the sill (regenerated: the first take copied objects from the reference) |
| site-visit-boots | a site office bench with a hard hat, a pair of muddy work boots, a high visibility vest folded, and an open notebook with a hand drawn sketch of pipes, no readable text |
| commissioning-tags | a close-up of many cables with blank tag labels in a terminal box, a clipboard checklist with tick marks beside it, a pen, no readable text |
| pressure-transmitter | a close-up of an industrial pressure transmitter mounted on a large pipe with a small isolation valve and a flexible conduit |
| flow-meter | a large magnetic flow meter fitted in a pipe inside a concrete pit, flanged joints, a cable gland and a small display housing |
| jackdaw-letter | a jackdaw in flight carrying a sealed envelope in its beak over the roof of a small brick pump station with a radio mast |
| calibrator-hands | two gloved hands connecting the red and black test leads of a loop calibrator to a terminal strip, close-up, no faces |

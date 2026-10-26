# P&ID / process schematic

> **First draft, Mantle's own type.** Written for review by a process or
> instrumentation engineer. Symbol shapes and line codes below follow common
> ISA-5.1 practice, but every site and contractor has its own legend sheet.
> When the user names a standard or shows a legend, that legend wins over
> this guide.

**Two layers.** This file is the base: generic rules any site can start
from. Each brain may keep a **site profile** for its own drawings, a
markdown file at `files/diagrams/profiles/pid.md` in that brain.
`diagram_guide` appends it after this guide, and where the two differ the
profile wins. The profile is the owner's data: it stays in the brain, never
in this repository. See "Growing the site profile" at the end.

**Best for:** a piping and instrumentation diagram, or a simplified process
schematic: equipment (vessels, pumps, exchangers), the pipes between them,
the valves on those pipes, and the instruments and control loops that
measure and act on the process. Use it when the reader needs to see which
instrument measures what, which valve it moves, and where a line goes.

**Not for:** a block flow diagram with no valves or instruments (use
`process` or `data-flow`), plant geography (use `axonometric-plan`), or a
pure control narrative with no equipment (use `flowchart` or `state`).

This is a static drawing of what the user gave you. Never invent a tag, a
line number, a set point or a piece of equipment to make the sheet look
complete. Draw what is known; list what is missing beside the deliverable.

## Layout conventions

**Flow direction.** Process flows left to right. Feed enters on the left
edge, product leaves on the right. Vessels and columns sit on a common
baseline about two thirds down the canvas; pumps sit below the vessel they
draw from; instruments sit above or beside the line they measure. Gravity is
real: a liquid outlet leaves from the bottom of a vessel, a vapour outlet
from the top.

**Z-order.** Background, then process lines, then signal lines, then
equipment, then valves and inline items, then instrument bubbles, then
labels. Equipment drawn after a line masks it, which is what a pipe entering
a vessel should look like.

**Routing.** Every connector rule from the shared rules holds: orthogonal
only, elbows at `r=8` (process lines may use square corners, `r=0`, which is
drawing-office practice; pick one per sheet), no overlaps, separate attach
points. Where two lines cross without joining, the later line breaks with a
hop (a semicircle of radius 6) or a 6px gap. A join is a filled dot of
radius 3. A crossing with no hop and no dot is ambiguous; never leave one.

**Arrowheads.** Put a flow arrow on a process line where it enters a piece of
equipment and after each branch, not on every segment. Signal lines carry no
arrowheads except where the direction is not obvious from the loop.

## Line types

Line style carries meaning on a P&ID. Here dashes mean a signal type, **not**
"optional or async" as in the other types; say so in the legend.

| Line                                                    | Stroke             | Pattern                                                                                |
| ------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| Main process line                                       | `{ink}`, width 2   | solid                                                                                  |
| Secondary process or utility line                       | `{ink}`, width 1.2 | solid                                                                                  |
| Instrument connection to the process, instrument supply | `{muted}`, width 1 | solid                                                                                  |
| Electric signal                                         | `{muted}`, width 1 | dashed `6,4`                                                                           |
| Pneumatic signal                                        | `{muted}`, width 1 | solid, with a pair of short slashes (`//`, 6px long, 45 degrees, 3px apart) every 40px |
| Data link (software, fieldbus, DCS internal)            | `{muted}`, width 1 | solid, with an open circle of radius 2 every 24px                                      |
| Capillary tube                                          | `{muted}`, width 1 | solid, with a small `x` every 24px                                                     |
| Hydraulic signal                                        | `{muted}`, width 1 | solid, with a short `L` mark every 40px                                                |

Draw the pattern marks as small paths on the line, not as markers or
patterns (they must survive as plain static SVG). Keep at most four line
types on one sheet; more is a legend nobody reads.

## Service colours (optional)

Monochrome is the default and is how most P&IDs are issued. Colour lines by
service only when the request is about the services ("show the steam and
cooling water"), and then reuse the series palette of the style guide:

| Service               | Colour                  | Typical code |
| --------------------- | ----------------------- | ------------ |
| Process               | `{ink}`                 | P            |
| Steam and condensate  | `series-4` (rust-brown) | ST, SC       |
| Cooling water         | `series-2` (dusty-blue) | CW, CWR      |
| Air and nitrogen      | `series-1` (sage)       | IA, PA, N    |
| Fuel gas, flare, vent | `series-3` (mustard)    | FG, FL, V    |
| Drains and chemicals  | `series-5` (slate)      | D, CH        |

The accent stays editorial: at most 2 elements, typically the loop or the
line the sheet is about. Every colour used appears in the legend.

## Equipment symbols

Equipment is drawn as an outline in `{ink}`, width 1.2, filled with
`{paper}`, so lines entering it are masked. Each piece carries its tag
(`V-101`) in the `{node-name}` role at 12px and an optional service line
(`FEED SURGE DRUM`) in the `{sublabel}` role at 9px, placed below or inside
the symbol. Sizes are on the 4px grid; scale them together, never one alone.

| Equipment                         | Shape                                                                                                                                    | Default size |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Vertical vessel, drum             | Rectangle with elliptical heads (end caps of height width/4)                                                                             | 64 x 160     |
| Horizontal drum                   | Rectangle with elliptical heads on the short sides                                                                                       | 160 x 64     |
| Column, tower                     | Tall vertical vessel; trays as short horizontal hairlines inside, or packing as a cross-hatched band                                     | 56 x 240     |
| Atmospheric tank                  | Rectangle, flat bottom, shallow cone or dome roof                                                                                        | 120 x 96     |
| Centrifugal pump                  | Circle (r 16) with the discharge leaving tangentially from the top; suction enters the centre from the side; a small triangle foot below | 40 x 40      |
| Positive displacement pump        | Circle (r 16) with an inner arrow or the letters `PD`                                                                                    | 40 x 40      |
| Compressor                        | Trapezoid narrowing in the flow direction, or a circle with two converging lines                                                         | 56 x 40      |
| Shell and tube exchanger          | Horizontal capsule (rect, `rx` = height/2) with a tube-side zigzag through it; shell nozzles on top and bottom                           | 128 x 40     |
| Generic exchanger, heater, cooler | Circle (r 20) with a zigzag line crossing it                                                                                             | 40 x 40      |
| Air cooler                        | Rectangle with a fan circle and two blades above it                                                                                      | 96 x 48      |
| Filter, strainer                  | Rectangle with a diagonal mesh line; a Y-strainer is a short branch off the line at 45 degrees with a cap                                | 32 x 24      |

Pumps in duty and standby pairs are drawn twice and tagged `P-101A` and
`P-101B`. Nozzles are not drawn unless the request is about them.

## Valves and inline items

Valves sit on the line, centred on it, in `{ink}` width 1. The body is a
bowtie: two triangles tip to tip, 16 wide and 12 high, axis along the line.

| Item                              | Symbol                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate valve (generic manual valve) | Open bowtie                                                                                                                                       |
| Globe valve                       | Bowtie with a filled dot (r 2) at the centre                                                                                                      |
| Ball valve                        | Bowtie with an open circle (r 3) at the centre                                                                                                    |
| Butterfly valve                   | Bowtie with a short bar across the centre                                                                                                         |
| Check valve                       | Bowtie with one triangle filled, the filled side downstream, plus a small flow arrow above                                                        |
| Three-way valve                   | Three triangles meeting at the centre                                                                                                             |
| Control valve                     | Globe body with a stem up to an actuator: a dome (semicircle, r 8) for a diaphragm, a small rectangle for a piston, a square with `M` for a motor |
| Pressure safety or relief valve   | Angle body (two triangles at a right angle, inlet from below, outlet to the side) with a zigzag spring above                                      |
| Reducer                           | Small trapezoid on the line                                                                                                                       |
| Spectacle blind                   | Figure eight: a filled and an open circle joined by a short bar                                                                                   |
| Vent, drain                       | Short branch ending in a cap or an open end, labelled `V` or `D`                                                                                  |

Normally closed manual valves are marked `NC` in the `{eyebrow}` role
beside the symbol (some legends fill the bowtie instead; text is clearer).
A control valve states its failure position below the body: `FO` (fail
open), `FC` (fail closed), `FL` (fail last).

## Instruments (ISA-5.1)

**The bubble.** A circle of diameter 40 in `{ink}` width 1, filled with
`{paper}`. The tag letters sit in the upper half (`{node-name}` role, 11px,
weight 600) and the loop number in the lower half (`{sublabel}` role, 9px).
A bubble connects to its process line or equipment with a thin solid
instrument line.

**Where it lives,** by the line through the bubble:

| Mark                      | Meaning                                                |
| ------------------------- | ------------------------------------------------------ |
| No line                   | Field mounted                                          |
| One solid horizontal line | Main control room, the operator can reach it           |
| Two solid lines           | Local or auxiliary panel, the operator can reach it    |
| One dashed line           | Behind a panel or in a cabinet, not normally reachable |

**What it is,** by the outline:

| Outline                 | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| Circle                  | Discrete instrument                                               |
| Circle inside a square  | Shared display or control (a DCS function)                        |
| Hexagon                 | Computer function                                                 |
| Diamond inside a square | Programmable logic (PLC)                                          |
| Diamond                 | Interlock or binary logic; put `I` inside or the interlock number |

Safety instrumented functions use whatever outline the site legend uses for
its safety system; ask, and mark it in the legend.

**Tag letters.** The first letter is the measured or initiating variable;
the following letters are the functions, in the order readout, then output.

| First letter | Variable         |     | Following letter | Function                |
| ------------ | ---------------- | --- | ---------------- | ----------------------- |
| A            | Analysis         |     | A                | Alarm                   |
| E            | Voltage          |     | C                | Control                 |
| F            | Flow             |     | E                | Primary element, sensor |
| H            | Hand (manual)    |     | G                | Gauge, sight glass      |
| I            | Current          |     | I                | Indicate                |
| J            | Power            |     | L                | Light                   |
| K            | Time             |     | R                | Record                  |
| L            | Level            |     | S                | Switch                  |
| P            | Pressure         |     | T                | Transmit                |
| S            | Speed, frequency |     | V                | Valve, damper           |
| T            | Temperature      |     | W                | Well (thermowell)       |
| V            | Vibration        |     | Y                | Relay, compute, convert |
| W            | Weight, force    |     | Z                | Final element, actuator |
| Z            | Position         |     |                  |                         |

Modifiers: `D` after the first letter means differential (`PDT`), `Q`
means totalise (`FQI`), `S` in second place on a safety device (`PSV`).
`H`, `L`, `HH` and `LL` after an alarm or switch letter give the trip level
(`LAH`, `LSLL`).

Common tags: `FT` flow transmitter, `FE` flow element (orifice plate drawn
as two short bars across the line), `FIC` flow indicating controller, `FV`
flow control valve, `PT`, `PI` local gauge, `PIC`, `PSV` relief valve, `LT`,
`LG` level gauge, `LIC`, `LAH`, `LSHH`, `TE` with `TW`, `TT`, `TIC`.

**A control loop** reads as a chain: the transmitter on the process
(`LT-101`), a signal line to the controller in the control room (`LIC-101`,
circle inside a square with one solid line), a signal line to the final
element (`LV-101`, a control valve on the outlet line). All three share the
loop number. Draw the chain with the fewest elbows and keep each loop's
signal lines from crossing another loop's where you can.

## Labels

**Line numbers.** A process line carries its line number written along the
line, above a horizontal run or to the left of a vertical one, in the
`{sublabel}` role at 9px, on a paper mask with the usual gap. A common form
is size, service, sequence and pipe class: `4"-P-1024-CS150`. Use the
user's format exactly; never make one up. Label each line once per sheet,
plus once after any branch.

**Equipment tags** follow the shared rules for node names: `V-101`,
`P-101A`, `E-101`. **Set points and trip values** go in a small callout
beside the bubble (`SP 2.5 barg`, `H 85 %`) in the `{eyebrow}` role, only
when the user gave them.

**Circuit labels.** Where the request groups lines into circuits or
systems (for inspection, isolation or corrosion work), draw each circuit as
a hairline dashed outline (`{soft}`, dashed `4,4`, `rx=8`) around its lines
and equipment, labelled in the top-left corner like a zone (`CIRCUIT C-03`).
Circuits must not overlap; a line belongs to one circuit.

## Sheet continuation

A line that continues on another sheet ends in an off-page connector: a
pentagon arrow, 56 wide and 24 high, pointing in the flow direction, on the
left or right edge of the canvas (the `pid` template puts a connector whose
pipes are all utility lines beside its equipment instead, and every other
one on the edge). Inside it, the other sheet's number
(`{eyebrow}` role); beside it, where the line goes or comes from
(`TO V-201` or `FROM E-305`) and the line number. A signal that continues
uses the same connector, drawn in `{muted}`. Number continuation pairs so a
reader can find the other end.

## Title block and legend

Mantle diagrams have no title block frame. The diagram `<title>` names the
unit or system (`Feed surge drum and transfer pumps`); the drawing number
and revision, when the user gave them, go in the `<desc>` and in a small
`{eyebrow}` line at the top right. The legend is the usual horizontal strip
at the bottom: every line type, outline type and service colour used, and
nothing else.

## Complexity budget

A P&ID is denser than the other types; this budget replaces the 9-node
limit of the shared rules for this type only.

| Limit                        | Rule                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| Max equipment items          | 8                                                                         |
| Max instrument bubbles       | 16                                                                        |
| Max valves and inline items  | 20                                                                        |
| Max control loops            | 5                                                                         |
| Max process lines (labelled) | 12                                                                        |
| Max line types in the legend | 4                                                                         |
| Max accent elements          | 2                                                                         |
| Size preset                  | `doc-wide` (1280 x 720) by default; `print-a3-landscape` for a full sheet |
| Line crossings               | 8 (the template warns past it)                                            |

The `pid` template sizes the sheet to what it holds and warns past 1280 wide,
past 4 kinds of line (pipes and signals; a bubble's connection stub is not
counted) and past 8 crossings: each warning names the fix.

Over budget: split by system or by sheet and join the parts with
continuation connectors. A simplified process schematic (equipment and main
lines only, no instruments) follows the ordinary 9-node budget.

## Anti-patterns

- Invented tags, loop numbers, line numbers or set points.
- Process lines and signal lines drawn in the same weight and colour.
- Dashed lines used for "optional" on a P&ID, where dashes mean an electric
  signal.
- Diagonal pipes. Real piping runs orthogonally on a P&ID.
- A line crossing another with no hop and no join dot.
- Bubbles floating with no connection to what they measure.
- Every valve and drain on the plant drawn on one canvas.
- Tag letters in an order that does not read (`CIF` instead of `FIC`).
- Colour by service on every line when the request was about one loop.

## Template data

A P&ID is drawn by the `pid` template: write the DATA below, never the SVG.
`diagram_render` with `template: "pid"` and this data draws it and lists
what to fix; `present_create` saves it as a canvas; `present_export` writes
the SVG for a page. The template does the layout this guide describes
(baseline, routing, hops, valve and label placement, ISA letters).

| Field                 | What it is                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`               | required, up to 80 characters                                                                                                                                                                                                                                                        |
| `description`         | one sentence on what the sheet shows (a warning when missing)                                                                                                                                                                                                                        |
| `sheet`               | `{ "number": "PID-0001", "revision": "A" }`, top right                                                                                                                                                                                                                               |
| `equipment[]`         | `id` (the tag, `V-101`), `type`, `service` (`FEED SURGE DRUM`), `focal`, layout hints `column` (0 is leftmost) and `row` (`base`, `below`)                                                                                                                                           |
| `equipment[].type`    | `vertical-vessel`, `horizontal-drum`, `column`, `tank`, `centrifugal-pump`, `pd-pump`, `compressor`, `shell-tube-exchanger`, `exchanger`, `air-cooler`, `filter`                                                                                                                     |
| `offpage[]`           | `id`, `direction` (`in`, `out`), `sheet`, `text` (`TO E-201`)                                                                                                                                                                                                                        |
| `lines[]`             | `number` (the user's line number, exactly), `from`, `to` (equipment, off-page or tee id; `to` may be an instrument tag), `fromPort`, `toPort` (`top`, `bottom`, `left`, `right`), `service`, `weight` (`main`, `secondary`), `inline[]`, `focal`; `end`, `deadleg`, `toward` (below) |
| `tees[]`              | `id` (`T-1`), `on` (the parent line's id or number), `near` (`from`, `to`), `at` (0 to 1 along the parent from its `from`; wins over `near`): a junction a branch starts or ends at                                                                                                  |
| `lines[].inline[]`    | `type` (`gate`, `globe`, `ball`, `butterfly`, `check`, `three-way`, `control`, `relief`, `reducer`, `blind`, `orifice`), `tag` (`LV-101`), `actuator` (`diaphragm`, `piston`, `motor`), `fail` (`FO`, `FC`, `FL`), `closed`, `focal`                                                 |
| `instruments[]`       | `tag` (ISA-5.1 letters then the loop number, `LIC-101`), `on` (an equipment id or a line number), `location` (`field`, `control-room`, `local-panel`, `behind-panel`), `display` (`discrete`, `shared`, `computer`, `plc`, `interlock`), `setpoint`, `focal`                         |
| `signals[]`           | `from`, `to` (instrument tags or tagged inline items), `type` (`electric`, `pneumatic`, `data`, `capillary`, `hydraulic`, `connection`)                                                                                                                                              |
| `circuits[]`          | `id`, `label`, `lines[]`, `equipment[]`, `colour` (`series-1` to `series-5` or `#rrggbb`); a line belongs to one circuit                                                                                                                                                             |
| `legend`, `showTitle` | `false` to leave the legend strip or the title out                                                                                                                                                                                                                                   |
| `lines[].note`        | a short mark beside a line, such as `INFERRED JOIN (GUESS)`                                                                                                                                                                                                                          |
| `legendNames`         | `{ main, secondary }`: the legend's names for the two weights (a traced circuit's main line and branches)                                                                                                                                                                            |
| `profile`             | the site profile; filled in for you from this brain's profile (below) when you leave it out                                                                                                                                                                                          |

Unknown fields are errors, and so are dangling ids, a tag whose letters are
not ISA-5.1, and a line number outside the profile's format when the profile
enforces it. Every error names the field and the fix; the tool returns them
all at once.

`style` (2: the colour set), `check` and `checks` (image checks) are
written for you: keep them. `view: { zoom: false }` hides the zoom controls.

**A drawing set.** Past the budget, split, never cut: `{ title, pages:
[{ id, title, data }] }`, each `data` a sheet as above. In a set a
connector takes `link` (a page id) and `focus` (an id there), and a line
takes `more: { text, link, focus }` (`+7 DEADLEGS`). Links print as
`SEE PAGE 3: <title>`; the export stacks the pages.

**Tees and branches.** A line that leaves another line mid-run (a header
take-off, a drain, a vent, a dead leg, a gauge tapping, a bypass) starts or
ends at a tee on that line; never leave one out. The tee sits on the parent
pipe, clear of its valves, with the join dot; the branch leaves square to
it. A branch ends at equipment, a connector, another tee (a bypass), an
instrument with no `on` (its bubble sits at the branch end), or stops:
`end: "open"` (a stub) or `"cap"`; `deadleg: true` adds a cap and a DL tag;
`toward` (`up`, `down`, `left`, `right`) picks the way a stop leaves. For
example `tees: [{ "id": "T-1", "on": "SUCT" }]` with the lines
`{ "from": "T-1", "to": "P-101B" }` and `{ "id": "DL-1", "from": "T-1", "deadleg": true }`.

A complete example (it draws as it stands):

```json
{
  "title": "Feed surge drum level control",
  "description": "Feed enters the surge drum V-101; transfer pumps P-101A/B send it on through level control valve LV-101 to sheet 2, with a relief valve to flare.",
  "sheet": {
    "number": "PID-0001",
    "revision": "A"
  },
  "equipment": [
    {
      "id": "V-101",
      "type": "vertical-vessel",
      "service": "FEED SURGE DRUM"
    },
    {
      "id": "P-101A",
      "type": "centrifugal-pump",
      "service": "TRANSFER PUMP"
    },
    {
      "id": "P-101B",
      "type": "centrifugal-pump",
      "service": "STANDBY"
    }
  ],
  "offpage": [
    {
      "id": "FEED",
      "direction": "in",
      "sheet": "1",
      "text": "FROM UNIT 1"
    },
    {
      "id": "TO-2",
      "direction": "out",
      "sheet": "2",
      "text": "TO E-201"
    },
    {
      "id": "FLARE",
      "direction": "out",
      "sheet": "9",
      "text": "TO FLARE HEADER"
    }
  ],
  "lines": [
    {
      "number": "6\"-P-1001-CS150",
      "from": "FEED",
      "to": "V-101",
      "inline": [
        {
          "type": "gate"
        }
      ]
    },
    {
      "number": "4\"-P-1002-CS150",
      "from": "V-101",
      "to": "P-101A",
      "inline": [
        {
          "type": "gate"
        }
      ]
    },
    {
      "number": "4\"-P-1012-CS150",
      "from": "V-101",
      "to": "P-101B",
      "inline": [
        {
          "type": "gate",
          "closed": true
        }
      ]
    },
    {
      "number": "3\"-P-1003-CS150",
      "from": "P-101A",
      "to": "TO-2",
      "inline": [
        {
          "type": "check"
        },
        {
          "type": "control",
          "tag": "LV-101",
          "fail": "FC",
          "focal": true
        }
      ]
    },
    {
      "number": "3\"-P-1013-CS150",
      "from": "P-101B",
      "to": "TO-2",
      "inline": [
        {
          "type": "check"
        }
      ]
    },
    {
      "number": "2\"-FL-1004-CS150",
      "from": "V-101",
      "fromPort": "top",
      "to": "FLARE",
      "weight": "secondary",
      "inline": [
        {
          "type": "relief",
          "tag": "PSV-101"
        }
      ]
    }
  ],
  "instruments": [
    {
      "tag": "LT-101",
      "on": "V-101"
    },
    {
      "tag": "LIC-101",
      "location": "control-room",
      "display": "shared",
      "setpoint": "SP 50 %",
      "focal": true
    },
    {
      "tag": "PI-102",
      "on": "3\"-P-1003-CS150"
    },
    {
      "tag": "LAH-103",
      "location": "control-room",
      "display": "shared"
    }
  ],
  "signals": [
    {
      "from": "LT-101",
      "to": "LIC-101",
      "type": "electric"
    },
    {
      "from": "LIC-101",
      "to": "LV-101",
      "type": "electric"
    },
    {
      "from": "LT-101",
      "to": "LAH-103",
      "type": "data"
    }
  ]
}
```

## Growing the site profile

Every site draws differently, so the site's standard is adopted over time,
one convention at a time. When the owner corrects a drawing ("our pumps are
drawn with the discharge on the right", "line numbers here are
AREA-SIZE-SERVICE-SEQ"), or shows a legend sheet, record it in the profile
so the next drawing gets it right:

1. Read the current profile: `diagram_guide` with this type returns it, or
   says there is none.
   Conventions the template applies itself go in ONE fenced block with the
   info string `json profile` (the template's site profile: `lineNumber`
   with a `pattern`, `example` and `enforce`, `colourByService`,
   `serviceColours`, `instrumentFirstLetters`, `symbols`, where
   `symbols.deadleg: "dashed"` dashes dead legs as well). The template
   tools read that block and pass it as the data's `profile`. Everything
   else in the file is notes for the drawing.
2. Add the convention under the matching heading, keeping everything that
   is already there.
3. Save the whole file with `file_create`: `parent_path`
   `files.diagrams.profiles`, `filename` `pid.md`, `overwrite` true.
4. Say what you added. Only record what the owner said or showed; never a
   guess.
5. A pid canvas keeps the profile it was saved with: a later change to the
   profile does not reach it on its own. To redraw one with the new
   profile, read its data with `present_get`, leave `profile` out, and save
   that data with `present_update`; the template tools fill in the
   profile as it is now. Say which canvases you redrew.

Suggested headings for the profile (use only those the site needs):

- **Symbols**: variants of valves, pumps, vessels, instruments that differ
  from the base guide.
- **Service colours**: the site's service codes and colours, if it uses
  colour.
- **Line numbers**: the format, with one made-up example in that format.
- **Circuits**: how circuits or corrosion loops are named and shown, and
  the drawing layer they come from.
- **Title block**: the fields the site expects (drawing number, revision,
  unit, sheet).
- **Tags**: the site's tag format where it differs from ISA-5.1.

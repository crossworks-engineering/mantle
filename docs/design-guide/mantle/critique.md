# Critique: a design review

Adapted for Mantle from Impeccable v4.9.1 `reference/critique.md` (Apache 2.0). Changed: condensed to one reviewer working from a picture and the source; the detector, the sub-agents, the stored snapshot and the overlays are left out.

Use this when someone asks what is wrong with an app, a canvas or a deck, or before a redesign. Look at the picture first (`present_render` for a canvas, `app_render` for an app), then read the source.

## 1. Specificity first

Before anything else: does it feel made for this product, or could an unrelated product use it unchanged? Name the category-default choices (layout, palette, type, components) and the missed chances for character. Judge this before you score.

## 2. Score Nielsen's 10 heuristics (0 to 4 each)

| #   | Heuristic                       | Ask                                                      |
| --- | ------------------------------- | -------------------------------------------------------- |
| 1   | Visibility of system status     | Does it show what is happening (loading, saved, failed)? |
| 2   | Match with the real world       | Are the words and order the user's, not the system's?    |
| 3   | User control and freedom        | Can the person undo, cancel, go back?                    |
| 4   | Consistency and standards       | Same control, same look, same place?                     |
| 5   | Error prevention                | Are bad inputs blocked or confirmed before harm?         |
| 6   | Recognition over recall         | Is what is needed visible, not remembered?               |
| 7   | Flexibility and efficiency      | Are there fast paths for frequent users?                 |
| 8   | Aesthetic and minimalist design | Is every element earning its place?                      |
| 9   | Error recovery                  | Do errors name the problem and the fix?                  |
| 10  | Help and documentation          | Is help there when needed?                               |

A 4 is genuinely excellent; most real interfaces score 20 to 32 of 40. On Persuade and Experience surfaces, 7 and 10 may be `n/a` with a one-line reason; then score out of 4 times the number you scored. Bands by percentage: 90 and up Excellent, 70 Good, 50 Acceptable, 30 Poor, below that Critical.

## 3. Cognitive load

Check eight things: single focus, chunks of four or fewer, related items grouped, a clear hierarchy, one decision at a time, four or fewer visible options per decision, nothing to remember from a previous screen, complexity revealed only when needed. Zero or one failure is good, two or three moderate, four or more critical. One primary action, one or two secondary; group the rest.

## 4. Walk the main task as two or three personas

- **Alex, power user:** wants speed and shortcuts; hates hand-holding. (Dashboards, data tools.)
- **Jordan, first-timer:** needs guidance at each step; leaves rather than guess. (Landing pages, onboarding, forms.)
- **Sam, screen reader and keyboard only:** needs focus order, labels, contrast. (Every app.)
- **Riley, stress tester:** long names, empty data, odd inputs, double clicks. (Forms, anything with data.)
- **Casey, distracted on a phone:** one hand, interrupted, slow link. (Landing pages, forms.)

Name the exact element that fails each one. No generic persona prose.

## 5. Write the report

1. **Overall impression:** what works, what does not, the single biggest opportunity.
2. **What works:** two or three specific strengths and why.
3. **Priority issues:** three to five, most important first. For each: the severity (P0 blocks the task, P1 causes real difficulty, P2 has a workaround, P3 is polish), what, why it matters to users, the concrete fix, and the `design_guide` topic that covers it (layout, typeset, colorize, clarify, harden, adapt, distill, quieter, bolder, polish).
4. **Persona red flags**, **minor observations**, and two or three questions that could unlock a better design.

Be direct and specific ("the submit button", not "some elements"). Prioritise ruthlessly. Do not soften: honest feedback is what makes the next build better.

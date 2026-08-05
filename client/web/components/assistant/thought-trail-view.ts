import type { ThoughtEvent } from './use-turn-stream';

/** Split the live trail into what ThoughtTrail's three display regions show
 *  (pure — kept out of the .tsx so it unit-tests without a JSX transform).
 *  `active` is the newest step (the footer line). `lastNarrated` is the newest
 *  narrated step whose line isn't already the active one — promoted to the
 *  persistent narration slot above the footer, so the narrator's paragraph
 *  stays readable while grounded tool lines tick past (it holds until a newer
 *  narration supersedes it, even if it arrived late). `past` is the history
 *  stack: everything else, minus the promoted step, and in 'replace' mode
 *  pruned to narrated paragraphs only (grounded noise is what replace mode
 *  exists to drop — narration is never deleted). */
export function liveTrailView(
  steps: ThoughtEvent[],
  mode: 'list' | 'replace',
): { past: ThoughtEvent[]; active: ThoughtEvent; lastNarrated: ThoughtEvent | null } {
  const active = steps[steps.length - 1]!;
  let lastNarrated: ThoughtEvent | null = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.narrated && s.label !== active.label) {
      lastNarrated = s;
      break;
    }
  }
  const history = steps.slice(0, -1).filter((s) => s !== lastNarrated);
  const past = mode === 'replace' ? history.filter((s) => s.narrated) : history;
  return { past, active, lastNarrated };
}

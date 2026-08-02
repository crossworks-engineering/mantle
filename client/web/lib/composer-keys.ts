/**
 * Keyboard decision table for the assistant composer. Pure, so the
 * Enter-overloading rules stay unit-testable as more features claim keys.
 *
 * Two features overload Enter today: the follow-up suggestion chip (send the
 * proposal when the composer is EMPTY) and the premature-Enter replace-state
 * correction (../components/assistant/replace-turn.ts, a streaming-time
 * resend). Their states are disjoint by construction: the chip only exists
 * after `done` (it's fetched post-finalize, cleared on every send, and not
 * rendered while `sending`), while the replace gate requires `sending`, so
 * this table never has to arbitrate between them; Enter with typed text always
 * routes 'send-draft', and only submit's own sending-branch consults the
 * replace gate. The invariant that keeps it safe: ANY typed text means Enter
 * belongs to the user's own draft. That includes a Stop-restored prompt, which
 * refills the draft and thereby disables chip-Enter. Coexistence is pinned in
 * composer-keys.test.ts.
 */

export type ComposerKeyAction =
  /** Empty composer + visible chip: Enter sends the suggestion verbatim. */
  | 'send-suggestion'
  /** Empty composer + visible chip: ArrowRight loads it into the draft for editing. */
  | 'edit-suggestion'
  /** Enter sends whatever the user typed; the unmodified default. */
  | 'send-draft'
  | 'none';

export function composerKeyAction(
  e: { key: string; shiftKey: boolean },
  draft: string,
  suggestion: string | null,
): ComposerKeyAction {
  const chipArmed = !!suggestion && !draft.trim();
  if (chipArmed) {
    if (e.key === 'Enter' && !e.shiftKey) return 'send-suggestion';
    if (e.key === 'ArrowRight') return 'edit-suggestion';
  }
  if (e.key === 'Enter' && !e.shiftKey) return 'send-draft';
  return 'none';
}

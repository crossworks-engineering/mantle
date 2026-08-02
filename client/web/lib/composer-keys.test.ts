import { describe, expect, it } from 'vitest';
import { composerKeyAction } from './composer-keys';
import { canReplaceInFlightTurn } from '../components/assistant/replace-turn';

const enter = { key: 'Enter', shiftKey: false };
const shiftEnter = { key: 'Enter', shiftKey: true };
const right = { key: 'ArrowRight', shiftKey: false };

describe('composerKeyAction', () => {
  it('sends the suggestion on Enter ONLY when the draft is empty', () => {
    expect(composerKeyAction(enter, '', 'Try it?')).toBe('send-suggestion');
    expect(composerKeyAction(enter, '   \n', 'Try it?')).toBe('send-suggestion');
  });

  it('any typed text hands Enter back to the draft; the chip never steals it', () => {
    expect(composerKeyAction(enter, 'my own question', 'Try it?')).toBe('send-draft');
    // A Stop-restored prompt refills the draft, which must disable chip-Enter.
    expect(composerKeyAction(enter, 'the restored prompt', 'Try it?')).toBe('send-draft');
  });

  it('without a chip, Enter sends the draft exactly as before', () => {
    expect(composerKeyAction(enter, 'hello', null)).toBe('send-draft');
    // Empty draft still routes to send-draft; submit's own empty-guard drops it
    // (the attachment-only path relies on reaching submit).
    expect(composerKeyAction(enter, '', null)).toBe('send-draft');
  });

  it('Shift+Enter always stays a newline', () => {
    expect(composerKeyAction(shiftEnter, '', 'Try it?')).toBe('none');
    expect(composerKeyAction(shiftEnter, 'text', null)).toBe('none');
  });

  it('ArrowRight loads the suggestion for editing only while the chip is armed', () => {
    expect(composerKeyAction(right, '', 'Try it?')).toBe('edit-suggestion');
    expect(composerKeyAction(right, 'typing already', 'Try it?')).toBe('none');
    expect(composerKeyAction(right, '', null)).toBe('none');
  });

  it('other keys pass through untouched', () => {
    expect(composerKeyAction({ key: 'a', shiftKey: false }, '', 'Try it?')).toBe('none');
    expect(composerKeyAction({ key: 'ArrowLeft', shiftKey: false }, '', 'Try it?')).toBe('none');
  });

  // The premature-Enter correction (replace-turn.ts) also overloads Enter,
  // while a turn STREAMS. The chip only exists after `done` (fetched
  // post-finalize, cleared on every send, not rendered while sending), while
  // the replace gate requires `sending`; the states are disjoint by
  // construction. Pin that here against both pure gates.
  describe('coexistence with the replace-state correction', () => {
    const replaceEligible = {
      streamingOn: true,
      stopping: false,
      activeTurnId: 'turn-1',
      hasAttachment: false,
      lastTurnHadFile: false,
    };

    it('chip-Enter can only fire when no turn is in flight, where the replace gate is closed', () => {
      // The chip is armed → the component is idle (sending=false: the chip is
      // cleared on submit and only fetched after done). In that state the
      // replace gate must refuse, so sending the suggestion is a plain turn.
      expect(composerKeyAction(enter, '', 'Try it?')).toBe('send-suggestion');
      expect(canReplaceInFlightTurn({ ...replaceEligible, sending: false })).toBe(false);
    });

    it('while streaming there is no chip, so Enter routes send-draft and only the replace gate decides', () => {
      // suggestion=null models the streaming state (dismissed on submit; the
      // next fetch starts only after done).
      expect(composerKeyAction(enter, 'a correction', null)).toBe('send-draft');
      expect(canReplaceInFlightTurn({ ...replaceEligible, sending: true })).toBe(true);
      // Empty draft mid-stream: still send-draft, and submit's own empty-text
      // guard turns it into a no-op; the chip never re-enters the picture.
      expect(composerKeyAction(enter, '', null)).toBe('send-draft');
    });
  });
});

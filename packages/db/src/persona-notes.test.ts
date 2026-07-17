import { describe, expect, it } from 'vitest';
import {
  activeNotes,
  applyPersonaUpdate,
  capNotes,
  noteRef,
  type PersonaUpdate,
} from './persona-notes';
import type { PersonaNote } from './schema/agents';

const NOW = '2026-05-20T12:00:00.000Z';
const NEW_ID = 'new-id-1';

function note(partial: Partial<PersonaNote> & { content: string }): PersonaNote {
  return { kind: 'style', at: '2026-01-01T00:00:00.000Z', ...partial };
}

describe('noteRef', () => {
  it('uses the id when present', () => {
    expect(noteRef(note({ id: 'abc', content: 'x' }))).toBe('abc');
  });
  it('falls back to a stable content hash for legacy notes', () => {
    const a = noteRef(note({ content: 'be relaxed' }));
    const b = noteRef(note({ content: 'be relaxed' }));
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
  });
});

describe('activeNotes', () => {
  it('filters out retired notes', () => {
    const notes = [
      note({ content: 'keep' }),
      note({ content: 'gone', retiredAt: NOW, retiredReason: 'removed' }),
    ];
    expect(activeNotes(notes).map((n) => n.content)).toEqual(['keep']);
  });
});

describe('applyPersonaUpdate', () => {
  it('adds a new note with the supplied id', () => {
    const res = applyPersonaUpdate(
      [],
      { add: { kind: 'style', content: 'Be professional' } },
      NOW,
      NEW_ID,
    );
    expect(res.added?.id).toBe(NEW_ID);
    expect(res.notes).toHaveLength(1);
    expect(res.retired).toEqual([]);
  });

  it('supersedes the named contradicting note and keeps it as audit', () => {
    const relaxed = note({ id: 'relaxed', content: 'Keep things relaxed and casual' });
    const update: PersonaUpdate = {
      add: { kind: 'style', content: 'Prefers a professional tone' },
      supersedeRefs: ['relaxed'],
    };
    const res = applyPersonaUpdate([relaxed], update, NOW, NEW_ID);

    // old note retired, not deleted
    expect(res.notes).toHaveLength(2);
    const old = res.notes.find((n) => n.id === 'relaxed')!;
    expect(old.retiredAt).toBe(NOW);
    expect(old.retiredReason).toBe('superseded');
    expect(old.supersededBy).toBe(NEW_ID);
    // only the new note is active
    expect(activeNotes(res.notes).map((n) => n.content)).toEqual(['Prefers a professional tone']);
    expect(res.retired).toEqual([{ ref: 'relaxed', reason: 'superseded' }]);
  });

  it('supersede without an add is a no-op on that note (needs a replacement)', () => {
    const relaxed = note({ id: 'relaxed', content: 'casual' });
    const res = applyPersonaUpdate([relaxed], { supersedeRefs: ['relaxed'] }, NOW, NEW_ID);
    expect(res.added).toBeNull();
    expect(activeNotes(res.notes)).toHaveLength(1); // untouched
    expect(res.retired).toEqual([]);
  });

  it('removes a note outright with no replacement', () => {
    const drop = note({ id: 'drop', content: 'use emoji liberally' });
    const res = applyPersonaUpdate([drop], { removeRefs: ['drop'] }, NOW, NEW_ID);
    expect(res.added).toBeNull();
    expect(activeNotes(res.notes)).toHaveLength(0);
    const retired = res.notes.find((n) => n.id === 'drop')!;
    expect(retired.retiredReason).toBe('removed');
    expect(retired.supersededBy).toBeUndefined();
  });

  it('supersedes multiple diffuse contradictions at once', () => {
    const notes = [
      note({ id: 'a', content: 'be relaxed' }),
      note({ id: 'b', content: 'use emoji' }),
      note({ id: 'c', content: 'crack jokes' }),
      note({ id: 'd', content: 'calls the user Jay' }), // unrelated — must survive
    ];
    const res = applyPersonaUpdate(
      notes,
      {
        add: { kind: 'style', content: 'Professional, formal tone' },
        supersedeRefs: ['a', 'b', 'c'],
      },
      NOW,
      NEW_ID,
    );
    expect(
      activeNotes(res.notes)
        .map((n) => n.content)
        .sort(),
    ).toEqual(['Professional, formal tone', 'calls the user Jay']);
    expect(res.retired).toHaveLength(3);
  });

  it('ignores refs that do not match any active note', () => {
    const keep = note({ id: 'keep', content: 'x' });
    const res = applyPersonaUpdate(
      [keep],
      { add: { kind: 'style', content: 'y' }, supersedeRefs: ['ghost'] },
      NOW,
      NEW_ID,
    );
    expect(res.retired).toEqual([]);
    expect(activeNotes(res.notes)).toHaveLength(2);
  });

  it('never re-retires an already-retired note', () => {
    const already = note({
      id: 'old',
      content: 'old',
      retiredAt: '2026-01-02T00:00:00.000Z',
      retiredReason: 'removed',
    });
    const res = applyPersonaUpdate([already], { removeRefs: [noteRef(already)] }, NOW, NEW_ID);
    expect(res.retired).toEqual([]);
    expect(res.notes[0]!.retiredAt).toBe('2026-01-02T00:00:00.000Z'); // unchanged
  });
});

describe('capNotes', () => {
  it('returns as-is under the cap', () => {
    const notes = [note({ content: 'a' }), note({ content: 'b' })];
    expect(capNotes(notes, 10)).toBe(notes);
  });

  it('never evicts active notes, drops oldest retired first', () => {
    const active = Array.from({ length: 3 }, (_, i) =>
      note({ id: `act${i}`, content: `active ${i}` }),
    );
    const retired = Array.from({ length: 5 }, (_, i) =>
      note({
        id: `ret${i}`,
        content: `retired ${i}`,
        retiredAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        retiredReason: 'removed',
      }),
    );
    const capped = capNotes([...retired, ...active], 5);
    // all 3 active survive
    expect(capped.filter((n) => !n.retiredAt)).toHaveLength(3);
    // budget for retired = 5 - 3 = 2, the two newest (ret3, ret4)
    const keptRetired = capped.filter((n) => n.retiredAt).map((n) => n.id);
    expect(keptRetired.sort()).toEqual(['ret3', 'ret4']);
  });

  it('keeps all active even if they exceed max', () => {
    const active = Array.from({ length: 6 }, (_, i) => note({ id: `act${i}`, content: `a${i}` }));
    const capped = capNotes(active, 3);
    expect(capped).toHaveLength(6);
  });
});

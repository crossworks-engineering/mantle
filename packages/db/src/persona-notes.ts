/**
 * Pure helpers for persona-note resolution. No DB access — the tool
 * handler and the reflector load/save; this module decides what the
 * note array should become.
 *
 * Design: scoped resolution, not full rewrite. An explicit user request
 * ("be more professional") supersedes the specific notes it contradicts
 * and adds the new one — it never re-authors unrelated identity. Notes
 * are soft-retired (kept for audit + reversibility), never deleted,
 * because persona has no immutable source to re-derive from.
 */

import { createHash } from 'node:crypto';
import type { PersonaNote } from './schema/agents';

/** Active + retired audit tail. capNotes never evicts an active note. */
export const MAX_PERSONA_NOTES = 200;

/** Stable handle for a note. Real id when present; otherwise a short
 *  content hash so legacy (id-less) notes are still addressable without
 *  a migration. Notes are immutable once written, so the hash is stable. */
export function noteRef(n: PersonaNote): string {
  if (n.id) return n.id;
  return createHash('sha256').update(n.content).digest('hex').slice(0, 8);
}

/** Notes the read path should inject — everything not retired. */
export function activeNotes(notes: PersonaNote[]): PersonaNote[] {
  return notes.filter((n) => !n.retiredAt);
}

export type PersonaUpdate = {
  add?: { kind: PersonaNote['kind']; content: string };
  /** Refs of active notes the new note replaces (retired as superseded). */
  supersedeRefs?: string[];
  /** Refs of active notes to retire outright (no replacement). */
  removeRefs?: string[];
};

export type PersonaUpdateResult = {
  notes: PersonaNote[];
  added: PersonaNote | null;
  retired: { ref: string; reason: 'superseded' | 'removed' }[];
};

/**
 * Apply a scoped persona update. Supersede/remove only ever touch
 * currently-active notes whose ref the caller named; everything else is
 * untouched. The new note (if any) is appended with a fresh id.
 */
export function applyPersonaUpdate(
  current: PersonaNote[],
  update: PersonaUpdate,
  now: string,
  newId: string,
): PersonaUpdateResult {
  const retired: { ref: string; reason: 'superseded' | 'removed' }[] = [];
  const toSupersede = new Set(
    (update.supersedeRefs ?? []).map((s) => s.trim()).filter(Boolean),
  );
  const toRemove = new Set((update.removeRefs ?? []).map((s) => s.trim()).filter(Boolean));

  const added: PersonaNote | null =
    update.add && update.add.content.trim().length > 0
      ? { id: newId, kind: update.add.kind, content: update.add.content.trim(), at: now }
      : null;

  const next = current.map((n) => {
    if (n.retiredAt) return n; // already retired — leave the audit row alone
    const ref = noteRef(n);
    // Supersede requires a replacement; without `add` it falls through.
    if (toSupersede.has(ref) && added) {
      retired.push({ ref, reason: 'superseded' });
      return { ...n, retiredAt: now, retiredReason: 'superseded' as const, supersededBy: newId };
    }
    if (toRemove.has(ref)) {
      retired.push({ ref, reason: 'removed' });
      return { ...n, retiredAt: now, retiredReason: 'removed' as const };
    }
    return n;
  });

  if (added) next.push(added);

  return { notes: capNotes(next, MAX_PERSONA_NOTES), added, retired };
}

/**
 * Bound array growth without ever evicting an active note. Keeps all
 * active notes; fills the remaining budget with the most-recent retired
 * ones, dropping oldest retired first. If active alone exceeds `max`,
 * all active notes are still kept (max is a soft audit bound, not a hard
 * cap on identity).
 */
export function capNotes(notes: PersonaNote[], max: number): PersonaNote[] {
  if (notes.length <= max) return notes;
  const active = notes.filter((n) => !n.retiredAt);
  const retired = notes.filter((n) => n.retiredAt);
  const budget = Math.max(0, max - active.length);
  const keptRetired = retired
    .slice()
    .sort((a, b) => (a.retiredAt! < b.retiredAt! ? 1 : -1)) // newest first
    .slice(0, budget);
  const keep = new Set<PersonaNote>([...active, ...keptRetired]);
  return notes.filter((n) => keep.has(n)); // preserve original ordering
}

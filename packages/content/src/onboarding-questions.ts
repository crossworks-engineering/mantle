/**
 * The first-run "what is this brain for" capture.
 *
 * Browser-safe leaf (NO `@mantle/db` import) so the onboarding wizard client can
 * render the archetypes and the server action can validate the chosen key from
 * the same source. The chosen archetype + a free-text description are persisted
 * as profile preferences (`purposeArchetype` + `purpose`, see
 * profile-preferences.ts) — first-class, settings-editable, and the seam a later
 * phase can branch provisioning on. The purpose then feeds the always-on
 * identity block (`identity-context.ts`) as a "# Purpose of this brain" section,
 * so every agent knows the brain's mission from turn one.
 *
 * This replaced the old multi-question personal interview: a brain is now as
 * often a specialist (data/RBI analytics, robotics, …) as it is a personal one,
 * so we capture the brain's PURPOSE rather than the operator's life story. The
 * passive `seed-get-to-know-user` heartbeat still harvests personal facts during
 * normal chat for the brains where that matters.
 */

/** A brain "speciality" the operator picks at first run. Purely descriptive in
 *  this phase (persisted + injected); a later phase can map a key to a
 *  provisioning profile (which specialists/tool-groups to emphasise). */
export type PurposeArchetype = {
  /** Stable key — persisted as `purposeArchetype`; never shown to the user. */
  key: string;
  /** Short label shown in the picker + the identity block's "Speciality:" line. */
  label: string;
  /** One-line description of what this kind of brain is for. */
  blurb: string;
};

/**
 * The archetype set. `personal` leads (the most common starting point); `custom`
 * trails as the description-only escape hatch. Order is the display order.
 */
export const PURPOSE_ARCHETYPES: PurposeArchetype[] = [
  {
    key: 'personal',
    label: 'Personal brain',
    blurb: 'A second brain for your life — notes, journal, tasks, people, and memory.',
  },
  {
    key: 'analytics',
    label: 'Data / RBI analytics',
    blurb: 'A specialist for analysing data, documents, and reports (RBI, NATREF, and similar).',
  },
  {
    key: 'research',
    label: 'Research',
    blurb: 'Gathering, reading, and synthesising sources into findings.',
  },
  {
    key: 'robotics',
    label: 'Robotics',
    blurb: 'Sensing, control, and operational data for a robot or device.',
  },
  {
    key: 'team',
    label: 'Team / org knowledge',
    blurb: 'Shared knowledge for a team — docs, decisions, and context in one place.',
  },
  {
    key: 'custom',
    label: 'Something else',
    blurb: 'Describe it yourself below.',
  },
];

export const PURPOSE_ARCHETYPE_KEYS: readonly string[] = PURPOSE_ARCHETYPES.map((a) => a.key);

/** Narrow an unknown value to a known archetype key. */
export function isPurposeArchetype(key: unknown): boolean {
  return typeof key === 'string' && PURPOSE_ARCHETYPE_KEYS.includes(key);
}

/** Archetype key → human label, tolerant of unknown values (returns null so the
 *  identity block can simply omit the "Speciality:" line). */
export function purposeArchetypeLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return PURPOSE_ARCHETYPES.find((a) => a.key === key)?.label ?? null;
}

/** Derive a short display name (first name) from a name answer. Falls back to the
 *  whole trimmed string when there's no whitespace. Kept from the old interview —
 *  the optional "Your name" field on the welcome step still uses it. */
export function deriveDisplayName(fullName: string): string {
  const flat = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.split(' ')[0] ?? flat;
}

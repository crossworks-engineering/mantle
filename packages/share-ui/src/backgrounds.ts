/**
 * WHERE a generated background may be applied, and which one each area uses.
 *
 * The style catalogue lives in avatar.ts (category `backgrounds`) and the
 * renderer in backdrop.ts; this module owns only the mapping from AREA to
 * style, plus the wire format that carries it from the DB to the document.
 *
 * A brain-level choice, like the colour theme and the avatar style: it is the
 * look of the product, not one login's taste.
 *
 * OFF IS A REAL CHOICE, not the absence of one. Every area can be bare, and a
 * bare area has to be storable, otherwise "I turned the header off" is
 * indistinguishable from "I never set the header", and the next default change
 * would silently switch it back on.
 */

import { BACKGROUND_STYLES } from './avatar';

/** The sentinel for "no background here". Not a style id, and deliberately not
 *  a name any DiceBear style could ever take. */
export const BACKGROUND_OFF = 'off';

export type BackgroundAreaId = 'menu' | 'header' | 'chat' | 'activity';

export type BackgroundArea = {
  id: BackgroundAreaId;
  label: string;
  /** What the user is actually about to decorate. */
  hint: string;
};

export const BACKGROUND_AREAS: BackgroundArea[] = [
  { id: 'menu', label: 'Menu', hint: 'The left navigation column' },
  { id: 'header', label: 'Brand', hint: 'Behind the logo and peer name' },
  { id: 'chat', label: 'Chat', hint: 'Behind the conversation' },
  { id: 'activity', label: 'Activity', hint: 'The right-hand live column' },
];

export const BACKGROUND_AREA_IDS: readonly BackgroundAreaId[] = BACKGROUND_AREAS.map((a) => a.id);

/**
 * What each area shows when the brain has never chosen.
 *
 * Only the menu is decorated out of the box. Turning on all four at once is a
 * decorated app rather than a decorated panel, and the point of a background is
 * that it is background, so the rest are opt-in.
 */
export const DEFAULT_AREA_BACKGROUNDS: Record<BackgroundAreaId, string> = {
  menu: 'waves',
  header: BACKGROUND_OFF,
  chat: BACKGROUND_OFF,
  activity: BACKGROUND_OFF,
};

export type AreaBackgrounds = Record<BackgroundAreaId, string>;

const BACKGROUND_STYLE_IDS = new Set(BACKGROUND_STYLES.map((s) => s.id));

function isArea(id: string): id is BackgroundAreaId {
  return (BACKGROUND_AREA_IDS as readonly string[]).includes(id);
}

/** Whether a value may be stored as an area's background. `off` counts; a style
 *  that is not in the `backgrounds` category does not, a portrait stretched
 *  across the sidebar is a giant face, not a background. */
export function isBackgroundChoice(v: string | null | undefined): boolean {
  return !!v && (v === BACKGROUND_OFF || BACKGROUND_STYLE_IDS.has(v));
}

/** Resolve one area's stored value. Unknown, empty and avatar-only ids fall
 *  back to the area's default rather than throwing or rendering nothing. */
export function resolveAreaBackground(
  area: BackgroundAreaId,
  v: string | null | undefined,
): string {
  return isBackgroundChoice(v) ? v! : DEFAULT_AREA_BACKGROUNDS[area];
}

/** Fill in every area, so consumers never branch on "unset". */
export function resolveBackgrounds(
  stored: Partial<Record<string, string>> | null | undefined,
): AreaBackgrounds {
  const out = {} as AreaBackgrounds;
  for (const a of BACKGROUND_AREAS) out[a.id] = resolveAreaBackground(a.id, stored?.[a.id]);
  return out;
}

/**
 * Wire format: `menu=waves,header=off`.
 *
 * Chosen over JSON because it rides in an HTML attribute; this needs no
 * quoting, survives a glance in devtools, and cannot smuggle anything: both
 * halves of every pair are validated on the way in AND on the way out.
 *
 * Areas already on their default are OMITTED, matching how every other
 * appearance attribute works: a default is the ABSENCE of the value, so
 * changing a default later actually reaches the brains that never chose.
 */
export function encodeBackgrounds(v: Partial<Record<string, string>> | null | undefined): string {
  if (!v) return '';
  const parts: string[] = [];
  for (const a of BACKGROUND_AREAS) {
    const choice = v[a.id];
    if (!isBackgroundChoice(choice)) continue;
    if (choice === DEFAULT_AREA_BACKGROUNDS[a.id]) continue;
    parts.push(`${a.id}=${choice}`);
  }
  return parts.join(',');
}

export function decodeBackgrounds(raw: string | null | undefined): AreaBackgrounds {
  const stored: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [area, choice] = pair.split('=');
    if (area && choice && isArea(area) && isBackgroundChoice(choice)) stored[area] = choice;
  }
  return resolveBackgrounds(stored);
}

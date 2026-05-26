/**
 * Pure shape + format helpers for contacts. NO database imports — this is the
 * module the browser-side `/contacts` client pulls from (via the
 * `@mantle/content/contacts-format` subpath) to avoid dragging `postgres` /
 * `@mantle/db` into the client bundle.
 *
 * The DB-using CRUD lives in `./contacts.ts`, which re-exports these so
 * server-side callers can keep importing from `@mantle/content`.
 */

/** Methods we count outbound contact attempts by. Open-ended on the data side
 *  (the jsonb just stores keys), but typed here for the call sites we wire
 *  ourselves so a typo becomes a compile error. Add new entries as we add
 *  surfaces. */
export type ContactMethod = 'email' | 'sms';

export type ContactCounts = Partial<Record<string, number>>;
export type ContactLastAt = Partial<Record<string, string>>;

export type ContactRow = {
  id: string;
  title: string;
  firstName: string;
  lastName: string;
  /** Organisation name. Independent of person name — supports both
   *  "John Smith" (no company), "Modular" (company-only, e.g. a supplier),
   *  and "John Smith @ Modular" (both). */
  company: string;
  email: string;
  countryCode: string;
  cell: string;
  /** E.164 normalised number, e.g. "+27760810774". Empty when no cell on file. */
  cellE164: string;
  /** Human-formatted cell with country code, e.g. "+27 76 081 0774". */
  cellFormatted: string;
  description: string;
  tags: string[];
  summary: string | null;
  /** Per-method count of outbound contact attempts (bumped on send success).
   *  Empty object when never contacted; missing keys read as 0. */
  contactCounts: ContactCounts;
  /** Per-method ISO timestamp of the most recent outbound. Missing keys = never. */
  lastContactedAt: ContactLastAt;
  createdAt: string;
  updatedAt: string;
};

export type CreateContactInput = {
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  countryCode?: string;
  cell?: string;
  description?: string;
  tags?: string[];
};

export type UpdateContactInput = CreateContactInput;

/** Strip everything but digits. Robust to user pasting "(760) 810-0774" etc. */
export function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D+/g, '');
}

/**
 * Normalise a country-code input. Accepts "+27", "27", or "00 27" — returns
 * "+27" if it looks like a plausible 1-4 digit country code, else "" (so the
 * caller can refuse). Pure.
 */
export function normalizeCountryCode(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  // "00 27" / "0027" → "27"
  const digits = digitsOnly(raw).replace(/^00/, '');
  // 1–4 digits and must NOT start with 0 — ITU-T E.164 codes are non-zero.
  if (digits.length < 1 || digits.length > 4 || digits.startsWith('0')) return '';
  return `+${digits}`;
}

/** E.164: country code + digits-only cell. Returns "" if either part is missing. */
export function toE164(countryCode: string, cell: string): string {
  const cc = normalizeCountryCode(countryCode);
  const local = digitsOnly(cell);
  if (!cc || !local) return '';
  return `${cc}${local}`;
}

/**
 * Group a national-number string into chunks for display. Defensive default:
 * group from the RIGHT into 4 + 3 + … so "760810774" → "76 081 0774". Country
 * code prepended separately. Good enough for ZA/UK/AU/most ITU plans; not a
 * libphonenumber replacement.
 */
export function formatCell(countryCode: string, cell: string): string {
  const cc = normalizeCountryCode(countryCode);
  const digits = digitsOnly(cell);
  if (!cc && !digits) return '';
  if (!digits) return cc;
  // Right-to-left groups: last 4, then 3, then 3, …
  const groups: string[] = [];
  let i = digits.length;
  while (i > 0) {
    const take = groups.length === 0 ? 4 : 3;
    const start = Math.max(0, i - take);
    groups.unshift(digits.slice(start, i));
    i = start;
  }
  return cc ? `${cc} ${groups.join(' ')}` : groups.join(' ');
}

/** Lower-case + trim. We compare emails case-insensitively across the system. */
export function normalizeEmail(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

/** Cheap structural email check — `<local>@<host>.<tld>`. Deliberately permissive;
 *  the SMTP server is the real authority. */
export function isPlausibleEmail(s: string): boolean {
  const e = normalizeEmail(s);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Derive the title shown for a contact, in precedence order:
 *   1. Person name ("First Last") — the most specific identifier when set.
 *   2. Company / organisation name — for supplier/org contacts with no person.
 *   3. Email address.
 *   4. Formatted cell number.
 *   5. "Untitled contact" — a brand-new empty draft (mirrors notes' "Untitled note").
 *  Name beats company so "Jane @ Modular" titles as "Jane Smith" with the
 *  company surfaced separately in the UI. Company-only contacts ("Modular"
 *  with no person) get the company as the title. */
export function deriveContactTitle(input: {
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  countryCode?: string;
  cell?: string;
}): string {
  const name = `${(input.firstName ?? '').trim()} ${(input.lastName ?? '').trim()}`.trim();
  if (name) return name.slice(0, 200);
  const company = (input.company ?? '').trim();
  if (company) return company.slice(0, 200);
  const email = normalizeEmail(input.email ?? '');
  if (email) return email.slice(0, 200);
  const fmt = formatCell(input.countryCode ?? '', input.cell ?? '');
  if (fmt) return fmt.slice(0, 200);
  return 'Untitled contact';
}

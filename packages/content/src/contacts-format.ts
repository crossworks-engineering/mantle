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
  /** Every email entry on the contact. Each is either a full address
   *  (`jason@schoeman.me`) or a `@domain` wildcard (`@schoeman.me` = all mail
   *  from that domain). The inbound gate matches against both; the outbound
   *  send allowlist uses concrete addresses only (see `partitionEmailEntries`). */
  emails: string[];
  /** Derived convenience = `emails[0] ?? ''`. Kept so existing list rows /
   *  tool projections that read a single `email` keep working unchanged. */
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
  /** Email entries — addresses and/or `@domain` wildcards. Preferred input. */
  emails?: string[];
  /** @deprecated single-email back-compat. Folded into `emails` if `emails`
   *  is absent. New callers should pass `emails`. */
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

/** Domain shape for `@domain` wildcard entries (lower-cased, no leading `@`).
 *  Mirrors the validator the retired senders UI used. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type EmailEntryKind = 'address' | 'domain' | 'invalid';

/**
 * Classify one contact email-list entry. A leading `@` marks a **domain
 * wildcard** (`@schoeman.me` = all mail from that domain); anything else must
 * be a plausible full address. A bare domain without `@` (`schoeman.me`) is
 * rejected so the wildcard intent is always explicit and never confused with a
 * malformed address.
 */
export function classifyEntry(raw: string): EmailEntryKind {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'invalid';
  if (s.startsWith('@')) return DOMAIN_RE.test(s.slice(1)) ? 'domain' : 'invalid';
  return isPlausibleEmail(s) ? 'address' : 'invalid';
}

/** Canonicalise an entry: lower-cased address, or `@domain` for a wildcard.
 *  Returns '' for invalid input (caller decides whether to reject). */
export function normalizeEmailEntry(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  switch (classifyEntry(s)) {
    case 'address':
      return s;
    case 'domain':
      return '@' + s.replace(/^@/, '');
    default:
      return '';
  }
}

/** True when the entry is a usable address OR a `@domain` wildcard. */
export function isPlausibleEmailOrDomain(raw: string): boolean {
  return classifyEntry(raw) !== 'invalid';
}

/** Normalise + de-dupe a list of entries, dropping anything invalid. Lenient —
 *  used for diffing/comparison where bad legacy values shouldn't throw. */
export function normalizeEmailEntries(entries: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries ?? []) {
    const norm = normalizeEmailEntry((raw ?? '').trim());
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Split a contact's email entries into concrete `addresses` and bare `domains`
 * (the `@` stripped). Entries are normalised + de-duped; invalid ones dropped.
 *
 * The **inbound** gate matches a From address against both sets. The
 * **outbound** send allowlist uses `addresses` only — you can't send to a whole
 * domain. This asymmetry is deliberate (a domain wildcard means "trust mail
 * FROM here", not "I may send anywhere here").
 */
export function partitionEmailEntries(entries: string[] | undefined): {
  addresses: string[];
  domains: string[];
} {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of entries ?? []) {
    const norm = normalizeEmailEntry(raw);
    if (!norm) continue;
    if (norm.startsWith('@')) domains.add(norm.slice(1));
    else addresses.add(norm);
  }
  return { addresses: [...addresses], domains: [...domains] };
}

/**
 * A contact has a usable identity when at least one of name, last name, or
 * company is set. Email/cell alone aren't enough — they're contact channels,
 * not identities. Used by the save-side validation in `updateContact` and by
 * the client form to pre-check before fetch. Pure + exported.
 */
export function hasIdentity(input: {
  firstName?: string;
  lastName?: string;
  company?: string;
}): boolean {
  return Boolean(
    (input.firstName ?? '').trim() ||
      (input.lastName ?? '').trim() ||
      (input.company ?? '').trim(),
  );
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
  emails?: string[];
  email?: string;
  countryCode?: string;
  cell?: string;
}): string {
  const name = `${(input.firstName ?? '').trim()} ${(input.lastName ?? '').trim()}`.trim();
  if (name) return name.slice(0, 200);
  const company = (input.company ?? '').trim();
  if (company) return company.slice(0, 200);
  const email = normalizeEmail(input.emails?.[0] ?? input.email ?? '');
  if (email) return email.slice(0, 200);
  const fmt = formatCell(input.countryCode ?? '', input.cell ?? '');
  if (fmt) return fmt.slice(0, 200);
  return 'Untitled contact';
}

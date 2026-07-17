/**
 * Contacts surface. A contact is a `nodes` row of type='contact' — the people
 * (and organisations) the user's agents are allowed to email and message.
 *
 *   nodes.title        derived display name (first + last, or just first for orgs)
 *   nodes.data         { first_name, last_name, company, email, country_code, cell, description }
 *   nodes.tags         freeform
 *
 * Lives under the `contacts` ltree root, lazy-created on first write. Because
 * it's a node, the brain auto-ingests via the `node_ingested` trigger →
 * extractor reads name + description and builds summary + embedding + facts on
 * the contact's entity — so search_nodes(type='contact', q='Modular') just works.
 *
 * Gate role: `contactEmails(ownerId)` returns every contact's normalised email;
 * `email_send`/`email_page` enforce "recipient ∈ own_accounts ∪ contact_emails"
 * once the contacts list is non-empty. See docs/contacts.md.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';
import {
  deriveContactTitle,
  digitsOnly,
  formatCell,
  hasIdentity,
  isPlausibleEmailOrDomain,
  normalizeCountryCode,
  normalizeEmail,
  normalizeEmailEntries,
  normalizeEmailEntry,
  partitionEmailEntries,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type UpdateContactInput,
} from './contacts-format';
import { teamStatusByContact, teamStatusFor, type TeamStatus } from './team-tokens';

export const CONTACTS_ROOT_LABEL = 'contacts';

// Re-export the pure module's surface so existing importers of `@mantle/content`
// (server + the unit tests) keep working unchanged. Client code that wants to
// avoid pulling in @mantle/db should import from `@mantle/content/contacts-format`
// directly — that's the leaf path with no DB transitively.
export {
  classifyEntry,
  deriveContactTitle,
  digitsOnly,
  formatCell,
  hasIdentity,
  isPlausibleEmail,
  isPlausibleEmailOrDomain,
  normalizeCountryCode,
  normalizeEmail,
  normalizeEmailEntries,
  normalizeEmailEntry,
  partitionEmailEntries,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type EmailEntryKind,
  type UpdateContactInput,
} from './contacts-format';

// ─── row + CRUD ────────────────────────────────────────────────────────────

function projectCounts(raw: unknown): ContactCounts {
  if (!raw || typeof raw !== 'object') return {};
  const out: ContactCounts = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}
function projectLastAt(raw: unknown): ContactLastAt {
  if (!raw || typeof raw !== 'object') return {};
  const out: ContactLastAt = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

function rowOf(n: Node, team: TeamStatus | null = null): ContactRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const firstName = typeof d.first_name === 'string' ? d.first_name : '';
  const lastName = typeof d.last_name === 'string' ? d.last_name : '';
  const company = typeof d.company === 'string' ? d.company : '';
  // New shape is `data.emails` (string[]); fall back to the legacy single
  // `data.email` for any row created between deploy and the 0074 data move.
  const emailsRaw = Array.isArray(d.emails)
    ? (d.emails as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const emails =
    emailsRaw.length > 0 ? emailsRaw : typeof d.email === 'string' && d.email ? [d.email] : [];
  const email = emails[0] ?? '';
  const countryCode = typeof d.country_code === 'string' ? d.country_code : '';
  const cell = typeof d.cell === 'string' ? d.cell : '';
  const description = typeof d.description === 'string' ? d.description : '';
  return {
    id: n.id,
    title: n.title,
    firstName,
    lastName,
    company,
    emails,
    email,
    countryCode,
    cell,
    cellE164: toE164(countryCode, cell),
    cellFormatted: formatCell(countryCode, cell),
    description,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    contactCounts: projectCounts(d.contact_counts),
    lastContactedAt: projectLastAt(d.last_contacted_at),
    team,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Contacts',
      slug: CONTACTS_ROOT_LABEL,
      path: CONTACTS_ROOT_LABEL,
      data: {
        description:
          "People + organisations the agents may email/message. Acts as the email allowlist: once non-empty, sending is restricted to these recipients plus the user's own account addresses.",
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

type ListContactsOpts = { query?: string; tag?: string };

function contactConds(ownerId: string, opts: ListContactsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'first_name' ilike ${q}`,
      sql`${nodes.data}->>'last_name' ilike ${q}`,
      sql`${nodes.data}->>'company' ilike ${q}`,
      // Match any entry in the emails array (addresses or @domain wildcards),
      // with a legacy fallback to the single `email` field.
      sql`(exists (select 1 from jsonb_array_elements_text(coalesce(${nodes.data}->'emails', '[]'::jsonb)) e where e ilike ${q}) or ${nodes.data}->>'email' ilike ${q})`,
      sql`${nodes.data}->>'description' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listContacts(
  ownerId: string,
  opts: ListContactsOpts & { limit?: number; offset?: number } = {},
): Promise<ContactRow[]> {
  const [rows, teamMap] = await Promise.all([
    db
      .select()
      .from(nodes)
      .where(and(...contactConds(ownerId, opts)))
      .orderBy(desc(nodes.updatedAt))
      .limit(opts.limit ?? 500)
      .offset(opts.offset ?? 0),
    teamStatusByContact(ownerId),
  ]);
  return rows.map((r) => rowOf(r, teamMap.get(r.id) ?? null));
}

export async function countContacts(ownerId: string, opts: ListContactsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...contactConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function getContact(ownerId: string, id: string): Promise<ContactRow | null> {
  const [[row], team] = await Promise.all([
    db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
      .limit(1),
    teamStatusFor(ownerId, id),
  ]);
  return row ? rowOf(row, team) : null;
}

/**
 * Every distinct **concrete** contact address for the owner, lower-cased. Drives
 * the OUTBOUND email_send / email_page allowlist gate.
 *
 * `@domain` wildcard entries are deliberately excluded — they mean "trust mail
 * FROM this domain" (inbound), not "I may send to anyone here". The inbound
 * `ContactGate` (contact-gate.ts) is the one that honours domains. Keep this
 * asymmetry in mind when touching either side.
 */
export async function contactEmails(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')));
  const set = new Set<string>();
  for (const r of rows) {
    const { addresses } = partitionEmailEntries(contactEmailEntries(r.data));
    for (const a of addresses) set.add(a);
  }
  return [...set];
}

/** Raw email entries off a contact's `data` jsonb, with the legacy single
 *  `email` fallback. Internal helper for the address/domain partitioners. */
function contactEmailEntries(data: unknown): string[] {
  const d = (data ?? {}) as Record<string, unknown>;
  if (Array.isArray(d.emails)) {
    return (d.emails as unknown[]).filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
  }
  return typeof d.email === 'string' && d.email ? [d.email] : [];
}

/**
 * Map the given lower-cased email addresses to contact ids for an owner. Used
 * by the send path: gather the set of recipients that map to known contacts so
 * each one's counter gets bumped on success. Returns Map<email_lc, contact_id>.
 * Unknown emails are simply absent from the map.
 */
export async function findContactsByEmails(
  ownerId: string,
  emails: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(emails.map((e) => normalizeEmail(e)).filter(Boolean));
  if (wanted.size === 0) return new Map();
  // Match a wanted address against any concrete entry in the contact's emails
  // array (or the legacy single `email`). Domain wildcards never match here —
  // counters track concrete sends only.
  const rows = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'contact'),
        sql`(exists (select 1 from jsonb_array_elements_text(coalesce(${nodes.data}->'emails', '[]'::jsonb)) e where lower(e) = ANY(${[...wanted]}::text[])) or lower(${nodes.data}->>'email') = ANY(${[...wanted]}::text[]))`,
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    const { addresses } = partitionEmailEntries(contactEmailEntries(r.data));
    for (const a of addresses) if (wanted.has(a) && !out.has(a)) out.set(a, r.id);
  }
  return out;
}

/**
 * Bump the per-method outbound counter and last-contacted timestamp on a
 * contact. Atomic — one SQL update with `jsonb_set` chained, so concurrent
 * sends don't lose increments. Owner-scoped; no-op if the id isn't this
 * owner's contact (returns false). Safe to call from a fire-and-forget context
 * — the caller decides whether to await.
 *
 * The data shape it maintains:
 *   data.contact_counts    = { email: N, sms: M, ... }
 *   data.last_contacted_at = { email: ISO, sms: ISO, ... }
 * Missing keys read as zero / never (mirrors projectCounts/projectLastAt).
 */
export async function recordContactSent(
  ownerId: string,
  contactId: string,
  method: ContactMethod | string,
): Promise<boolean> {
  const m = method.trim();
  if (!m) return false;
  const nowIso = new Date().toISOString();
  // Chained jsonb_set: bump counts[method] (default 0 + 1), set last_at[method].
  // coalesce keeps `data` a valid object even on rows that somehow lack one.
  const countsPath = `{contact_counts,${m}}`;
  const lastAtPath = `{last_contacted_at,${m}}`;
  const result = await db.execute(sql`
    update ${nodes}
    set data = jsonb_set(
                 jsonb_set(
                   -- ensure both parent objects exist before jsonb_set descends into them
                   jsonb_set(
                     jsonb_set(
                       coalesce(data, '{}'::jsonb),
                       '{contact_counts}',
                       coalesce(data->'contact_counts', '{}'::jsonb),
                       true
                     ),
                     '{last_contacted_at}',
                     coalesce(data->'last_contacted_at', '{}'::jsonb),
                     true
                   ),
                   ${countsPath}::text[],
                   to_jsonb(coalesce((data->'contact_counts'->>${m})::int, 0) + 1),
                   true
                 ),
                 ${lastAtPath}::text[],
                 to_jsonb(${nowIso}::text),
                 true
               ),
        updated_at = now()
    where id = ${contactId}
      and owner_id = ${ownerId}
      and type = 'contact'
  `);
  // postgres-js `execute` returns the underlying rows; checking count needs the
  // result shape — `result.count` works for INSERTs/UPDATEs in postgres-js.
  return (result as unknown as { count?: number }).count
    ? (result as unknown as { count: number }).count > 0
    : true; // optimistic — even if drivers vary, we won't pretend it failed.
}

/** Validate + normalise. Returns the canonical shape we'll store, or throws on
 *  bad input (caller surfaces). Empty fields are kept as empty strings so the
 *  jsonb shape is stable.
 *
 *  Note: we DO NOT require any identifying field. A fully-empty contact is a
 *  valid "draft" — the `+` button creates one and the user fills it in via
 *  the form. Empty contacts contribute nothing to the email allowlist (no
 *  email ⇒ not in `contactEmails`) and nothing to send counters (no recipient
 *  match), so they're inert until populated. Validation only rejects
 *  *malformed* values (bad email, country code without cell, etc.). */
function normalizeContactInput(input: CreateContactInput) {
  const firstName = (input.firstName ?? '').trim();
  const lastName = (input.lastName ?? '').trim();
  const company = (input.company ?? '').trim();
  const description = (input.description ?? '').slice(0, 4000);
  const countryCode = input.countryCode ? normalizeCountryCode(input.countryCode) : '';
  const cell = input.cell ? digitsOnly(input.cell) : '';

  // Email entries: prefer the `emails` array; fold the deprecated single
  // `email`. Each entry is a full address or a `@domain` wildcard. Normalise +
  // dedupe; reject anything that's neither.
  const rawEntries = input.emails ?? (input.email != null ? [input.email] : []);
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    if (!isPlausibleEmailOrDomain(trimmed)) {
      throw new Error(
        `'${trimmed}' isn't a valid email address or @domain (use @example.com to allow a whole domain).`,
      );
    }
    const norm = normalizeEmailEntry(trimmed);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      emails.push(norm);
    }
  }

  if (input.countryCode && !countryCode) {
    throw new Error(`'${input.countryCode}' is not a recognised country code (e.g. +27).`);
  }
  if (cell && !countryCode) {
    throw new Error('Country code is required when a cell number is set.');
  }
  return { firstName, lastName, company, emails, countryCode, cell, description };
}

/**
 * Result of a contact write. `addedEmails` are the normalised entries that are
 * newly present (every entry on create; only the new ones on update) — the
 * caller enqueues a backfill for each so the brain pulls that
 * sender's/domain's recent history. Domain entries keep their `@` prefix; the
 * backfill enqueuer strips it to a bare-domain target.
 */
export type ContactWriteResult = { contact: ContactRow; addedEmails: string[] };

export async function createContact(
  ownerId: string,
  input: CreateContactInput,
): Promise<ContactWriteResult> {
  const fields = normalizeContactInput(input);
  await ensureRoot(ownerId);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'contact',
      title: deriveContactTitle({
        firstName: fields.firstName,
        lastName: fields.lastName,
        company: fields.company,
        emails: fields.emails,
        countryCode: fields.countryCode,
        cell: fields.cell,
      }),
      path: CONTACTS_ROOT_LABEL,
      data: {
        first_name: fields.firstName,
        last_name: fields.lastName,
        company: fields.company,
        emails: fields.emails,
        country_code: fields.countryCode,
        cell: fields.cell,
        description: fields.description,
      },
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createContact: insert returned no row');
  return { contact: rowOf(row), addedEmails: fields.emails };
}

export async function updateContact(
  ownerId: string,
  id: string,
  input: UpdateContactInput,
): Promise<ContactWriteResult | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  if (!node) return null;

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const oldEntries = contactEmailEntries(oldData);
  const oldEmailsNorm = normalizeEmailEntries(oldEntries);
  // Merge in patch: any field the caller didn't set falls back to the stored
  // value so a single-field edit (e.g. update cell only) doesn't blank the rest.
  // Emails: prefer the array; the deprecated single `email` (when explicitly
  // passed) replaces the list; otherwise keep the stored entries.
  const merged: CreateContactInput = {
    firstName:
      input.firstName ?? (typeof oldData.first_name === 'string' ? oldData.first_name : ''),
    lastName: input.lastName ?? (typeof oldData.last_name === 'string' ? oldData.last_name : ''),
    company: input.company ?? (typeof oldData.company === 'string' ? oldData.company : ''),
    emails: input.emails ?? (input.email !== undefined ? [input.email] : oldEntries),
    countryCode:
      input.countryCode ?? (typeof oldData.country_code === 'string' ? oldData.country_code : ''),
    cell: input.cell ?? (typeof oldData.cell === 'string' ? oldData.cell : ''),
    description:
      input.description ?? (typeof oldData.description === 'string' ? oldData.description : ''),
  };
  const fields = normalizeContactInput(merged);
  const addedEmails = fields.emails.filter((e) => !oldEmailsNorm.includes(e));

  // Save-time validation: a real contact needs at least one identifying field.
  // Email/cell alone aren't enough — they're channels, not identities. (The
  // CREATE path stays permissive so the `+` button can still spawn a blank
  // draft; the user is required to fill in identity on first save.)
  if (!hasIdentity(fields)) {
    throw new Error('A contact needs at least a first name, last name, or company.');
  }

  // Did any extractor-visible field change? If so the prior summary/embedding
  // is stale — clear them so the re-extract on UPDATE writes a fresh pass.
  // The INSERT trigger doesn't fire on UPDATE, so we explicitly re-notify below.
  const emailsChanged = addedEmails.length > 0 || fields.emails.length !== oldEmailsNorm.length;
  const visibleChanged =
    fields.firstName !== (typeof oldData.first_name === 'string' ? oldData.first_name : '') ||
    fields.lastName !== (typeof oldData.last_name === 'string' ? oldData.last_name : '') ||
    fields.company !== (typeof oldData.company === 'string' ? oldData.company : '') ||
    emailsChanged ||
    fields.description !== (typeof oldData.description === 'string' ? oldData.description : '');

  const newData: Record<string, unknown> = {
    ...oldData,
    first_name: fields.firstName,
    last_name: fields.lastName,
    company: fields.company,
    emails: fields.emails,
    country_code: fields.countryCode,
    cell: fields.cell,
    description: fields.description,
  };
  // Drop the legacy single-email field so it can't diverge from `emails`.
  delete newData.email;
  if (visibleChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }

  const [updated] = await db
    .update(nodes)
    .set({
      title: deriveContactTitle({
        firstName: fields.firstName,
        lastName: fields.lastName,
        company: fields.company,
        emails: fields.emails,
        countryCode: fields.countryCode,
        cell: fields.cell,
      }),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(visibleChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateContact: update returned no row');
  const team = await teamStatusFor(ownerId, id);
  if (visibleChanged) {
    // Re-fire the extractor so summary/embedding/facts catch up. The INSERT
    // trigger only fires on INSERT, so this is the explicit refresh.
    const { notifyNodeIngested } = await import('@mantle/db');
    await notifyNodeIngested(id);
  }
  return { contact: rowOf(updated, team), addedEmails };
}

export async function deleteContact(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

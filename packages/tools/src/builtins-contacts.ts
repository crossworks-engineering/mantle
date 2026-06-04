/**
 * Contacts builtins — the index of people/organisations Saskia may email and
 * (later) SMS. Because contacts gate `email_send`/`email_page`, these tools
 * are the user-facing way Saskia "extends her reach": add a contact ⇒ that
 * recipient becomes mailable. The tool descriptions are deliberately strict on
 * "only when the user explicitly asks" because the user said so — there's no
 * approval gate (requiresConfirm:false), the restraint lives in the prompt.
 *
 * Reading shape:
 *   contact_find  → fuzzy name/email lookup that resolves "mail Modular" to {id,email,…}.
 *   contact_list  → browse (recent first).
 *   contact_get   → full record.
 *
 * Writing shape:
 *   contact_create / contact_update / contact_delete — operator-driven only.
 *
 * All `nodes` of type='contact'; insert/update goes through @mantle/content
 * which fires the extractor so each contact's description gets indexed into
 * the brain automatically (so search_nodes(q='Modular') also finds them).
 */

import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  type ContactRow,
  type CreateContactInput,
} from '@mantle/content';
import { enqueueBackfills } from '@mantle/email';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
/** Coerce an `emails` input to a clean string[] (or undefined to leave alone). */
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .map((e) => e.trim());
  return out.length ? out : undefined;
}

/** Compact projection for tool output — keeps the LLM context light, returns
 *  everything Saskia needs to act (incl. counters so "we've emailed Modular 5
 *  times" is reachable without a second call). */
function compact(c: ContactRow) {
  return {
    id: c.id,
    title: c.title,
    first_name: c.firstName,
    last_name: c.lastName,
    company: c.company,
    emails: c.emails,
    email: c.email,
    cell_e164: c.cellE164,
    cell_formatted: c.cellFormatted,
    description: c.description,
    tags: c.tags,
    contact_counts: c.contactCounts,
    last_contacted_at: c.lastContactedAt,
  };
}

// ─── read ──────────────────────────────────────────────────────────────────

const contact_find: BuiltinToolDef = {
  slug: 'contact_find',
  name: 'Find a contact',
  description:
    "Look up one of the user's contacts by name OR email (substring, case-insensitive). Use this FIRST whenever the user refers to someone by name ('email Modular', 'text Sarah') — it returns the contact's id, email, and cell so you can pass them to email_send / sms_send. Returns up to `limit` matches, most-recently-updated first; if you get more than one back, pick the obvious match or ask the user to disambiguate.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'name, surname, or email fragment' },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
    },
    required: ['query'],
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim();
    if (!query) return { ok: false, error: 'query is required' };
    const limit = Math.min(num(input.limit, 5), 25);
    const rows = await listContacts(ctx.ownerId, { query, limit });
    ctx.step?.setOutput({ count: rows.length });
    return {
      ok: true,
      output: { query, count: rows.length, contacts: rows.map(compact) },
    };
  },
};

const contact_list: BuiltinToolDef = {
  slug: 'contact_list',
  name: 'List contacts',
  description:
    "Browse the user's contacts, newest-updated first. Useful when the user asks 'who do I know?' or 'show me my contacts'. For finding a specific person, prefer `contact_find` — it's narrower.",
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  handler: async (input, ctx) => {
    const limit = Math.min(num(input.limit, 50), 200);
    const offset = Math.max(0, num(input.offset, 0));
    const rows = await listContacts(ctx.ownerId, { limit, offset });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: { count: rows.length, contacts: rows.map(compact) } };
  },
};

const contact_get: BuiltinToolDef = {
  slug: 'contact_get',
  name: 'Read a contact',
  description: "Fetch one contact by its node id. Returns the full record including counters.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const row = await getContact(ctx.ownerId, id);
    if (!row) return { ok: false, error: 'contact not found' };
    return { ok: true, output: compact(row) };
  },
};

// ─── write ─────────────────────────────────────────────────────────────────

/** Shared description suffix — keep "only when explicitly asked" loud across
 *  all three mutation tools. Contacts gate the email send path, so an agent
 *  spontaneously creating one would silently extend its own reach. */
const ONLY_WHEN_ASKED =
  ' Use ONLY when the user explicitly asks to save / update / remove a contact ' +
  '(e.g. "add this business card as a contact", "save Modular as orders@modular.co.za"). ' +
  "Never add contacts on your own initiative just because someone's name came up in conversation.";

const contact_create: BuiltinToolDef = {
  slug: 'contact_create',
  name: 'Add a contact',
  description:
    "Save someone or some organisation as a contact in the user's Mantle. At least one of `first_name`/`last_name`/`emails`/`cell` is required. `emails` is a list — each entry is a full address (`jason@schoeman.me`) OR a `@domain` wildcard (`@schoeman.me`, which trusts ALL mail from that domain inbound). The `description` is the natural-language note the AI reads — say who this person is, the relationship, what they do; it's indexed into the brain (summary, embedding, facts) so future searches like 'who supplies aluminium profiles?' find this contact. **Contacts are the email allowlist in BOTH directions:** adding one enables Saskia to email those addresses AND lets their mail be ingested into the brain (a 90-day history backfill kicks off automatically)." +
    ONLY_WHEN_ASKED,
  inputSchema: {
    type: 'object',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: {
        type: 'string',
        description:
          'Organisation name. Set this for a supplier/org contact (e.g. "Modular"); can also be paired with a person name.',
      },
      emails: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Email addresses and/or `@domain` wildcards. e.g. ["jason@schoeman.me", "@schoeman.me"].',
      },
      email: { type: 'string', description: 'Deprecated single-email shorthand; prefer `emails`.' },
      country_code: { type: 'string', description: 'E.g. "+27"; required if cell is set' },
      cell: { type: 'string', description: 'Digits only or any format; non-digits are stripped' },
      description: {
        type: 'string',
        description: "Who this is, for the AI. Free-form text.",
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
  handler: async (input, ctx) => {
    const fields: CreateContactInput = {
      firstName: strOpt(input.first_name),
      lastName: strOpt(input.last_name),
      company: strOpt(input.company),
      emails: strArr(input.emails),
      email: strOpt(input.email),
      countryCode: strOpt(input.country_code),
      cell: strOpt(input.cell),
      description: strOpt(input.description) ?? '',
      tags: Array.isArray(input.tags)
        ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    };
    try {
      const { contact, addedEmails } = await createContact(ctx.ownerId, fields);
      // Pull each newly-added sender's/domain's recent history into the brain
      // (best-effort; never fails the create).
      await enqueueBackfills(ctx.ownerId, addedEmails);
      ctx.step?.setOutput({ id: contact.id, title: contact.title });
      return { ok: true, output: compact(contact) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const contact_update: BuiltinToolDef = {
  slug: 'contact_update',
  name: 'Update a contact',
  description:
    "Patch a contact — only the fields you pass change (omit a field to keep its stored value). Pass `emails` to REPLACE the whole email list (addresses and/or `@domain` wildcards); newly-added entries trigger a 90-day history backfill. Useful when the user says 'their email actually changed to X', 'also accept anything from @acme.com', or 'tag Modular as a supplier'." +
    ONLY_WHEN_ASKED,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: { type: 'string' },
      emails: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Replaces the email list. Each entry is an address or a `@domain` wildcard.',
      },
      email: { type: 'string', description: 'Deprecated single-email shorthand; prefer `emails`.' },
      country_code: { type: 'string' },
      cell: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const patch: CreateContactInput = {
      firstName: typeof input.first_name === 'string' ? input.first_name : undefined,
      lastName: typeof input.last_name === 'string' ? input.last_name : undefined,
      company: typeof input.company === 'string' ? input.company : undefined,
      emails: strArr(input.emails),
      email: typeof input.email === 'string' ? input.email : undefined,
      countryCode: typeof input.country_code === 'string' ? input.country_code : undefined,
      cell: typeof input.cell === 'string' ? input.cell : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      tags: Array.isArray(input.tags)
        ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : undefined,
    };
    try {
      const result = await updateContact(ctx.ownerId, id, patch);
      if (!result) return { ok: false, error: 'contact not found' };
      await enqueueBackfills(ctx.ownerId, result.addedEmails);
      ctx.step?.setOutput({ id: result.contact.id, title: result.contact.title });
      return { ok: true, output: compact(result.contact) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const contact_delete: BuiltinToolDef = {
  slug: 'contact_delete',
  name: 'Delete a contact',
  description:
    "Remove a contact. NOTE: this also removes them from the email allowlist — Saskia can no longer email them after deletion. Returns ok=true on success; ok=false if the contact wasn't found." +
    ONLY_WHEN_ASKED,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const ok = await deleteContact(ctx.ownerId, id);
    if (!ok) return { ok: false, error: 'contact not found' };
    ctx.step?.setOutput({ id });
    return { ok: true, output: { id } };
  },
};

export const CONTACT_TOOLS: BuiltinToolDef[] = [
  contact_find,
  contact_list,
  contact_get,
  contact_create,
  contact_update,
  contact_delete,
];

/** Subset auto-granted to conversational agents (responder/assistant) at boot.
 *  Reads + adds, NOT delete — destructive ops should be explicit grants in
 *  /settings/tools, not silently auto-added to every agent's allowlist. */
export const CONTACT_AUTO_GRANT_SLUGS: readonly string[] = [
  'contact_find',
  'contact_list',
  'contact_get',
  'contact_create',
  'contact_update',
];

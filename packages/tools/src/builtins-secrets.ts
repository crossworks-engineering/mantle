/**
 * Builtins: secret_create — sealed credentials.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { sql } from 'drizzle-orm';
import { db, nodes, secrets } from '@mantle/db';
import { seal } from '@mantle/crypto';
import { nodeUrl } from '@mantle/content';
import { type BuiltinToolDef } from './types';
import { str } from './coerce';

const SECRET_KIND_VALUES = ['password', 'token', 'server', 'card', 'note', 'other'] as const;

const SECRETS_ROOT_LABEL = 'secrets';

export const secret_create: BuiltinToolDef = {
  slug: 'secret_create',
  name: 'Capture a secret',
  description:
    "Capture a sensitive value — password, PIN, API key, recovery code, anything the user explicitly says is private — into the encrypted /secrets store. ALWAYS prefer this over `note_create` or `file_create` for a dictated credential: a note stores it in plaintext where any future tool call can read it, while this seals the value behind a key only the owner's browser session can unlock. The value is REDACTED in trace logs — never echo it back to the user; confirm by title only ('saved your safe PIN'). For multi-field secrets (e.g. a server with both username and password) the /secrets UI is still the right path; this handles the common one-value case.",
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'short label, e.g. "Safe PIN", "Linode root password"',
      },
      value: {
        type: 'string',
        description: 'the secret value itself — gets encrypted before storage',
      },
      kind: {
        type: 'string',
        enum: [...SECRET_KIND_VALUES],
        description: 'rough category; pick the closest match',
      },
      label: {
        type: 'string',
        description:
          "optional field label inside the secret (e.g. 'PIN', 'password'). Defaults to 'value'.",
      },
      description: {
        type: 'string',
        description:
          'optional plaintext metadata visible to search (do NOT include the value here)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
    },
    required: ['title', 'value', 'kind'],
  },
  redactInputFields: ['value'],
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    const value = str(input.value);
    const kindRaw = str(input.kind);
    const label = str(input.label).trim() || 'value';
    const description = str(input.description).slice(0, 4000);
    const tagsIn = Array.isArray(input.tags)
      ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    if (!title) return { ok: false, error: 'title required' };
    if (!value) return { ok: false, error: 'value required' };
    const kind = (SECRET_KIND_VALUES as readonly string[]).includes(kindRaw) ? kindRaw : 'other';

    // Lazy-create the `secrets` ltree root the same way the UI does.
    await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'branch',
        title: 'Secrets',
        slug: SECRETS_ROOT_LABEL,
        path: SECRETS_ROOT_LABEL,
        data: {
          description:
            'Encrypted credentials, tokens, and other sensitive notes. Metadata is searchable; values stay sealed until you click reveal.',
        },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });

    // Sanitise tags (max 20, lowercase, dedup, 40 chars each).
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of tagsIn) {
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= 20) break;
    }

    // Insert metadata row first to get the node id (needed as AAD).
    const [inserted] = await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'secret',
        title: title.slice(0, 200),
        slug: null,
        path: SECRETS_ROOT_LABEL,
        data: {
          description,
          kind,
          has_note: false,
          field_count: 1,
        },
        tags,
      })
      .returning();
    if (!inserted) return { ok: false, error: 'failed to insert secret node' };

    // Seal the payload — single labeled field. AAD binds ciphertext to
    // this node id so an attacker who swaps the bytea column can't
    // replay another secret's ciphertext into this row.
    const payload = JSON.stringify({
      note: '',
      fields: [{ label: label.slice(0, 60), value }],
    });
    const sealed = seal(payload, `secret:${inserted.id}`);
    await db.insert(secrets).values({
      nodeId: inserted.id,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });

    // Trace meta deliberately omits the value. setOutput is also
    // safe: only id + title + kind. Never include the value here.
    ctx.step?.setOutput({ id: inserted.id, title: inserted.title, kind });
    return {
      ok: true,
      output: {
        id: inserted.id,
        url: nodeUrl(inserted.id),
        title: inserted.title,
        kind,
        message:
          'Saved to /secrets. The value is sealed — confirm by title only, do not repeat it back to the user.',
      },
    };
  },
};

/** Store a credential the user shared in conversation. */
export const SECRET_TOOLS: readonly BuiltinToolDef[] = [secret_create];

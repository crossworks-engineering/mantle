# Secrets

> AES-256-GCM-sealed credentials with metadata-only indexing.
> Live at `/secrets` in the web UI; encrypted at rest in the `secrets`
> table; metadata mirrored onto `nodes` so the assistant can find them
> by description without ever decrypting the value.
> A workspace kind since 0400 (owner, 2026-11-26): people share passwords,
> `.env` files and logins with each other. A user who reads a secret may
> reveal it by hand; each reveal is logged. No app or agent reads a value.

---

## 1. The shape

Each secret is two rows:

| Row                       | Holds                                                         |
| ------------------------- | ------------------------------------------------------------- |
| `nodes` (type='secret')   | plaintext: title, description, kind, tags, summary, embedding |
| `secrets` (node_id-keyed) | AES-256-GCM ciphertext of `{note, fields}`                    |

The split is the security model: anything you'd want the LLM to read
(so it can answer "where's my Linode password?") lives on `nodes`.
Anything you'd never want it to read (the password itself) lives in
`secrets`, sealed with a key the agent process can't even ask for
unless someone explicitly calls `revealSecret`.

The payload schema (decrypted):

```ts
{
  note: string,                    // free-form markdown
  fields: { label: string, value: string }[]   // ad-hoc field pairs
}
```

Hybrid by design: copy-username-only ergonomics for the structured
fields, plus an escape hatch for anything that doesn't fit neatly into
fields (recovery questions, OAuth client secrets with paragraphs of
context, etc.).

---

## 2. Encryption

`@mantle/crypto` wraps Node's `crypto`:

- **AES-256-GCM** with the master key from `MANTLE_MASTER_KEY` (32
  bytes, base64).
- **Per-row AAD** of `"secret:<node_id>"`, ciphertext from one row
  can't be replayed against another row even if an attacker swaps
  the bytea column.
- **Ciphertext layout** is opaque: `version(1) | iv(12) | tag(16) | ct(n)`,
  one bytea column.
- **Key version** is stored on the row so a future rotation can
  decrypt v1 ciphertext and re-seal as v2.

If `MANTLE_MASTER_KEY` is missing, the secrets surface throws on first
write or first reveal, never a silent fallback to plaintext.

---

## 3. Metadata-only extraction

The extractor agent (`server/api/src/agent/extractor.ts`) is the boundary.
`readNodeBodyRaw` has a hard-coded special case for `type='secret'`:

```ts
if (node.type === 'secret') {
  const description = data.description ?? '';
  const kind = data.kind ?? '';
  return `${title}\n\nKind: ${kind}\n\n${description}\n\nTags: ${tags}`;
}
```

That's the **only** thing the LLM sees. The `secrets` table is never
queried from this file. If you ever add a code path that loads
ciphertext or calls `open()` in the extractor, the whole threat model
breaks.

The result:

- Summary + embedding indexed on title + description + tags → semantic
  search ("my Linode root password") works.
- Facts extracted from the description → end up in the `facts` table.
  ("Alex has a Linode VPS in Frankfurt" is fine, that's not the
  password.)
- The actual values stay in `secrets.ciphertext` and only leave via
  the explicit `revealSecret` API.

`HARD_SKIP_TYPES` used to include `'secret'` (defence-in-depth: skip
secrets even if the agent config says to extract). It now contains
only `'branch'`; secrets are extracted with metadata only, by design.

---

## 3a. Sharing (0400)

A secret has a home and grants like a note ([workspaces.md](./workspaces.md),
"Items and grants" and "Secrets"): Read lists it and reveals it, Write edits
it, a Moderator of its home deletes it and changes its grants. Every call
runs in the caller's own scope (`@mantle/content/secrets`). The write role
holds no right on the `secrets` table; it reaches the sealed value through
two definers only:

| Definer                                    | Asks of the scope | Does                               |
| ------------------------------------------ | ----------------- | ---------------------------------- |
| `mantle_secret_put(node, sealed, version)` | edit              | makes or replaces the sealed value |
| `mantle_secret_sealed(node)`               | read              | returns the ciphertext, or null    |

The ciphertext alone is useless without the master key, which only the app
process holds, and only `revealSecret` opens it. The reveal route writes an
audit row (`secret.reveal`, `detail.secretId`, never the value), awaited,
before it calls `revealSecret`: a reveal whose row fails reveals nothing.
An Admin user with the users area reads the audit log.

The narrow system role holds no right on the `secrets` table either, and
the structure definer `mantle_structure_item` takes no secret (migration
0401): a login with the keys area writes a secret only as any login does,
in its own scope, under the workspace rules.

Secrets made before 0400 stay homed in Admin with no grant: no member reads
one until a person shares it, and every user of the Admin workspace reads
them (before, only the keys area's): trusted logins, accepted.

What stays strict: no public link, no peer grant, no `/api/v1` row (so no
API key), no MCP tool that reveals (the route ledger's "people" line), and
extraction reads metadata only, as before.

## 4. Where they live in the tree

A lazy-created `secrets` root branch holds every secret as a child:

```
secrets                   ← branch (lazy-created on first secret)
  └── (every secret pinned here in v1)
```

v1 keeps it flat, kind + tags do the organising. The pattern leaves
room for `secrets.work`, `secrets.personal`, etc. if you want folders
later, exactly mirroring how `files.*` works.

The `secrets` branch is NOT host-mirrored (no disk presence). Secrets
are Postgres-only.

---

## 5. The UI

### `/secrets`: list

- Search by title / description / tag.
- Filter by kind (password, token, server, card, note, other).
- Filter by tag.
- "New secret" modal with title, description, kind, tags, fields, note.

### `/secrets/[id]`: detail

- Metadata always visible (title, kind, description, tags, summary).
- Values sealed by default: shows "{n} fields + note · sealed" + a
  Reveal button.
- After reveal: each field has its own show/hide eye and a copy-to-
  clipboard button. Copy doesn't require revealing.
- Click "Hide" to re-seal locally (the React state drops; the next
  reveal hits the server again).
- "Edit" mode: title/description/tags can be updated alone; if you
  edit note/fields the blob gets re-sealed.

There's no re-auth prompt before reveal, the session cookie already
proves it's you. Anyone who steals the session can already do
anything you can; an extra password prompt is theatre.

---

## 6. API

| Method | Path                       | Needs (any login, its own scope) | Returns                                  |
| ------ | -------------------------- | -------------------------------- | ---------------------------------------- |
| GET    | `/api/secrets`             | reads                            | `{secrets: SecretRow[]}` (metadata only) |
| POST   | `/api/secrets`             | `?ws=` names where it lands      | `{secret: SecretRow}`                    |
| GET    | `/api/secrets/[id]`        | read                             | `{secret: SecretRow}` (metadata only)    |
| PATCH  | `/api/secrets/[id]`        | edit                             | `{secret: SecretRow}` (metadata only)    |
| DELETE | `/api/secrets/[id]`        | manage                           | `{ok: true}`                             |
| POST   | `/api/secrets/[id]/reveal` | read (logged first)              | `{metadata, payload: {note, fields}}`    |

Reveal is its own route so it stands out in access logs and audits.
`Cache-Control: no-store` is set on the reveal response so no
intermediate cache stores plaintext.

---

## 7. Known sharp edges

- **No reveal over MCP, by the owner's word.** `secret_create` saves a
  one-value secret; nothing reveals one to a model (owner, 2026-11-26:
  not for apps or agents to use). Copy a value from the screen.
- **No version history.** Updates overwrite the blob.
- **Who revealed it** is in the audit log only (`secret.reveal`); the
  secret's own screen does not list it yet.
- **`MANTLE_MASTER_KEY` rotation is manual.** A new key version bump
  in `@mantle/crypto` needs a re-seal pass over every existing row.
  No script for that yet.

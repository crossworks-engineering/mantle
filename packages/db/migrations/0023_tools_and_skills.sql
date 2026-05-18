-- Tools + skills registry.
--
-- `tools` registers something an agent can DO (function call).
-- `skills` registers something an agent KNOWS how to do (instructions + suggested toolset).
-- agents.tool_slugs / skill_slugs bind individual agents to subsets of the registry.
--
-- For v1 owner_id is part of the natural key so each user gets their own
-- copy of the built-ins (allows per-user overrides later). When/if Mantle
-- ever grows multi-tenant a global=null+owner=null hybrid stays open.

CREATE TABLE tools (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug             text NOT NULL,
  name             text NOT NULL,
  description      text NOT NULL,
  /* JSON Schema describing the tool's input shape — sent to the model so it
     knows what to ask for. */
  input_schema     jsonb NOT NULL DEFAULT '{}'::jsonb,
  /* Handler descriptor. One of:
       { "kind": "builtin", "ref": "search_nodes" }
       { "kind": "http",    "url": "...", "method": "POST", "headers_ref": null, "auth_ref": null }
       { "kind": "shell",   "cmd": "echo ${input.text}" }   -- v5 feature, gated.
  */
  handler          jsonb NOT NULL,
  /* When true, the tool-calling loop pauses and surfaces the proposed call
     for operator approval instead of auto-running. Defaults vary by kind. */
  requires_confirm boolean NOT NULL DEFAULT false,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE INDEX tools_owner_idx ON tools(owner_id);

CREATE TABLE skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL,
  /* Markdown body. Injected into the system prompt of any agent this skill
     is attached to (always-loaded for v1). */
  instructions  text NOT NULL DEFAULT '',
  /* The tools this skill expects to use. The agent's effective tool set is
     the union of agent.tool_slugs and every attached skill's tool_slugs. */
  tool_slugs    text[] NOT NULL DEFAULT '{}'::text[],
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE INDEX skills_owner_idx ON skills(owner_id);

-- Bind agents to their available tool + skill slugs. Arrays of text rather
-- than join tables — single-user scale, no need for the indirection. The
-- existing `tools jsonb default '[]'` column from migration 0011 was never
-- wired up; we keep it for now (might revisit) and use the new arrays.
ALTER TABLE agents
  ADD COLUMN tool_slugs  text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN skill_slugs text[] NOT NULL DEFAULT '{}'::text[];

-- Entities + entity_edges — the graph axis of the profile layer.
-- Persona evolution support — agents.persona_notes column.
-- Wires facts.entity_id to entities(id) now that the table exists.

create table if not exists "public"."entities" (
  "id"          uuid primary key default gen_random_uuid(),
  "owner_id"    uuid not null references auth.users(id) on delete cascade,
  "kind"        text not null,           -- 'person' | 'project' | 'place' | 'event' | 'org' | …
  "name"        text not null,
  "aliases"     text[] not null default '{}'::text[],
  "data"        jsonb not null default '{}'::jsonb,
  "embedding"   vector(1536),
  "created_at"  timestamptz not null default now(),
  "updated_at"  timestamptz not null default now()
);

create index if not exists "entities_owner_kind_idx"
  on "public"."entities"("owner_id", "kind");

-- Fuzzy name + alias match (Sarah ≈ Sara). Trigram GIN.
create index if not exists "entities_name_trgm_idx"
  on "public"."entities" using gin ("name" gin_trgm_ops);

-- Vector similarity over entity names + aliases for semantic resolution
-- ("my wife" → person 'Sarah').
create index if not exists "entities_embedding_idx"
  on "public"."entities" using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- Edges: typed, directional relationships. Source and target can each be
-- an entity, a fact, or a node — polymorphic. No FK on source/target_id
-- because there are three possible target tables; integrity is enforced
-- at the application level.
create table if not exists "public"."entity_edges" (
  "id"           uuid primary key default gen_random_uuid(),
  "owner_id"     uuid not null references auth.users(id) on delete cascade,
  "source_id"    uuid not null,
  "source_kind"  text not null,         -- 'entity' | 'fact' | 'node'
  "target_id"    uuid not null,
  "target_kind"  text not null,
  "relation"     text not null,         -- 'married_to' | 'works_at' | 'mentioned_in' | …
  "data"         jsonb not null default '{}'::jsonb,
  "valid_from"   timestamptz,
  "valid_to"     timestamptz,           -- Zep-style temporal: when did this stop being true?
  "created_at"   timestamptz not null default now()
);

create index if not exists "entity_edges_source_idx"
  on "public"."entity_edges"("source_id", "relation");
create index if not exists "entity_edges_target_idx"
  on "public"."entity_edges"("target_id", "relation");

-- Now wire facts.entity_id to entities. Set NULL on entity delete so
-- facts stay queryable even if their primary entity goes away.
alter table "public"."facts"
  add constraint "facts_entity_id_fkey"
  foreign key ("entity_id") references "public"."entities"(id) on delete set null;

-- Persona evolution. The reflector agent appends notes to this array.
-- Format: [{ kind: 'style' | 'relationship' | 'correction', content: text,
--           at: iso-timestamp, source?: { type: 'turn'|'digest', id: uuid } }]
alter table "public"."agents"
  add column if not exists "persona_notes" jsonb not null default '[]'::jsonb;

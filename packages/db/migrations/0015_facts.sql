-- The `facts` table — the durable, declarative half of the profile layer.
-- Each row is one statement of something true about the user or their world,
-- with citation back to the source content via source_node_id, and a
-- temporal window via valid_from / valid_to so superseded facts stay
-- queryable (Zep-style temporal model).
--
-- entity_id is declared here as a plain uuid; the FK to entities(id) is
-- added in 0016 once the entities table exists.

do $$ begin
  create type "public"."fact_kind" as enum ('factual', 'episodic', 'semantic', 'preference');
exception when duplicate_object then null; end $$;

create table if not exists "public"."facts" (
  "id"              uuid primary key default gen_random_uuid(),
  "owner_id"        uuid not null references auth.users(id) on delete cascade,
  "content"         text not null,
  "kind"            "public"."fact_kind" not null,
  "entity_id"       uuid,
  "confidence"      real not null default 1.0,
  "valid_from"      timestamptz,
  "valid_to"        timestamptz,
  "source_node_id"  uuid references "public"."nodes"(id) on delete set null,
  "embedding"       vector(1536),
  "superseded_by"   uuid references "public"."facts"(id),
  "data"            jsonb not null default '{}'::jsonb,
  "dirty"           boolean not null default false,
  "created_at"      timestamptz not null default now(),
  "updated_at"      timestamptz not null default now()
);

-- "Currently-true facts of this kind for this user" — the hot lookup for retrieval.
create index if not exists "facts_owner_kind_idx"
  on "public"."facts"("owner_id", "kind") where "valid_to" is null;

-- Find currently-true facts about a specific entity.
create index if not exists "facts_owner_entity_idx"
  on "public"."facts"("owner_id", "entity_id") where "valid_to" is null;

-- Find facts derived from a particular source node (for the dirty/re-extract flow).
create index if not exists "facts_source_node_idx"
  on "public"."facts"("source_node_id");

-- Vector similarity for top-K retrieval. 100 lists is the sweet spot until
-- the table is much larger; pgvector recommends sqrt(rows) lists as a rule
-- of thumb, ~ several thousand rows assumed initially.
create index if not exists "facts_embedding_idx"
  on "public"."facts" using ivfflat (embedding vector_cosine_ops) with (lists = 100);

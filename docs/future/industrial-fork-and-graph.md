# Parked note — industrial fork + graph reasoning

> **Status: parked / strategic.** Not part of the active build. Deliberately not
> linked from the README doc index — this is a "come back to this" note, not a
> spec. Captured 2026-05-29.

## The decision

A potential contract would **fork Mantle into a role-specialised industrial
system** (Jason's wife works mechanical integrity & reliability for refineries):
several Mantles, each owning a domain — e.g. a **corrosion specialist** Mantle
holding all corrosion/RBI data — that **query each other** via the federation
layer. A "rotating equipment" Mantle asks the corrosion Mantle a question; it
answers from its scoped, granted data.

**Conclusion: this is a genuine fork, not a feature of the life-tree.** It
conflicts with the single-user "Jason's life tree" identity:

- **Different data**: equipment → circuits → CMLs → damage mechanisms →
  inspection readings over time. A structured *domain* graph, not personal memory.
- **Different stakes**: feeds *inspection decisions* → safety + compliance. Audit,
  provenance, and possibly regulatory requirements that the personal tree never had.
- **Different tenancy**: org-scale, multi-role federation needs the auth/sharing
  model hardened well beyond the single-user sealed-token version shipped 2026-05.

The good news: Mantle's core design is *unusually* well-suited to regulated
integrity knowledge — **everything traced, every fact citable to a source node**
is exactly what asset-integrity work demands. The fork keeps that spine; it
diverges on tenancy, domain modelling, and the graph.

## On the graph database question

The instinct ("a real graph DB — Neo4j / Memgraph / Apache AGE") is right in
spirit but the **sequencing** matters. Two distinct graphs are easy to conflate:

1. **Memory graph** (today): `entities ↔ nodes` via co-occurrence. Fuzzy,
   extractor-derived. Postgres is fine for this forever; a graph DB is overkill.
2. **Domain knowledge graph** (the refinery need): equipment/loops/damage-
   mechanisms, multi-hop, ontology-shaped, genuinely queried. *This* is where a
   graph engine could earn its keep.

**Key finding (2026-05-29):** the schema gap is smaller than assumed.
`entity_edges` is *already* typed, directional, polymorphic (entity|fact|node),
**temporal** (`valid_from`/`valid_to`), and attributed (`data` jsonb). The rails
are laid. What's missing is (a) anything that *writes* relations other than
`mentioned_in`, and (b) *multi-hop traversal* exposed to the responder. So the
first move is **not** a new datastore — it's relation extraction + a traversal
layer in plain Postgres (recursive CTEs).

**Engine sequencing when/if we outgrow plain SQL:**
1. Recursive CTEs over the existing typed edges — zero new infra. Start here.
2. **Apache AGE** (Cypher *inside* Postgres) — preserves one-datastore / one-
   backup elegance. Caveat: maturity, packaging, composes awkwardly with
   pgvector/ltree.
3. **Neo4j / Memgraph** — only if AGE's traversal/perf genuinely falls short AND
   the graph becomes a first-class product surface. Cost: a second source of
   truth (dual-write, sync, consistency, separate backups) — real, and against
   the self-hosted single-VPS philosophy. Let *measured queries* justify it, not
   anticipation.

**The harder problem than the engine:** federation + **ontology**. For a
corrosion Mantle to be queryable by others, both sides must share a vocabulary
of what entities and relations *mean*. The federation query layer (scoped,
traced, per-node grants — shipped 2026-05) is the right shape to carry
graph-shaped questions across the border once that shared model exists. Nail the
ontology before the engine.

## Follow-ups (rough priority)

1. **Typed-edge reasoning in Postgres** (active discussion): relation extraction
   beyond `mentioned_in` + recursive-CTE traversal helper + expose to the
   responder (not just the MCP `entity_neighbors`/`entity_facts` tools). Backend-
   agnostic; useful for the life-tree too.
2. **Prototype the corrosion/RBI domain** on (1) — real entities + typed
   relations + real multi-hop queries. Measure where Postgres stops being enough.
3. **Re-evaluate the engine** with evidence from (2). AGE before Neo4j/Memgraph.
4. **Industrial fork scoping**: tenancy/auth hardening, audit/provenance,
   regulatory posture — separate from the life-tree codebase's assumptions.

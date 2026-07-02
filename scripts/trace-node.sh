#!/usr/bin/env bash
# Trace one node through every layer of Mantle's 6-layer brain.
#
# Given a node id, dumps its full footprint: the content_store row + any
# specialised table, the content_index fields (summary / embedding /
# entities / tsv), the profile facts, the graph edges, and the trace
# trail (extractor_run + steps). Read-only — never mutates.
#
# Usage:
#   scripts/trace-node.sh <node-uuid>
#   scripts/trace-node.sh                 # no id → lists the 10 newest nodes
#
# Companion doc: docs/data-flow-tracing.md
#
# Connects via `docker exec` into the running postgres container — mantle_dev_pg
# on dev machines, mantle_pg on deployed boxes. Override with MANTLE_PG_CONTAINER
# if yours differs (or if both are running on one host).

set -euo pipefail

pick_pg() {
  running() { docker ps --filter "name=$1" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
  if running mantle_pg && running mantle_dev_pg; then
    echo "✗ both mantle_pg and mantle_dev_pg are running — set MANTLE_PG_CONTAINER to pick one." >&2
    return 1
  fi
  if running mantle_dev_pg; then echo mantle_dev_pg; else echo mantle_pg; fi
}
PG="${MANTLE_PG_CONTAINER:-$(pick_pg)}"
psql() { docker exec "$PG" psql -U postgres -d postgres "$@"; }

if ! docker exec "$PG" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "postgres container '$PG' not reachable — is the stack up? (pnpm infra:up)" >&2
  exit 1
fi

N="${1:-}"
if [ -z "$N" ]; then
  echo "No node id given. The 10 newest nodes:"
  psql -c "
    select id, type, left(title,48) as title, to_char(created_at,'MM-DD HH24:MI') as created,
           (nullif(data->>'summary','') is not null) as summary,
           (embedding is not null) as emb
    from nodes order by created_at desc limit 10;"
  echo "Re-run with:  scripts/trace-node.sh <id>"
  exit 0
fi

echo "============================================================"
echo " Tracing node $N"
echo "============================================================"

echo ""; echo "── L6 content_store: nodes core ─────────────────────────────"
psql -c "select type, title, path, tags, to_char(created_at,'YYYY-MM-DD HH24:MI:SS') as created,
                (updated_at > created_at) as touched_by_extractor
         from nodes where id='$N';"

echo ""; echo "── L6 specialised tables (if any) ───────────────────────────"
psql -c "select 'email' as kind, e.from_addr as detail, e.has_attachments::text as extra
         from emails e where e.node_id='$N'
         union all
         select 'attachment', a.filename, a.mime_type from email_attachments a where a.file_node_id='$N'
         union all
         select 'telegram', t.direction::text, coalesce(t.text,'') from telegram_messages t where t.node_id='$N'
         union all
         select 'secret', 'sealed', '(metadata-only path)' from secrets s where s.node_id='$N';"

echo ""; echo "── L5 content_index: summary / embedding / entities / tsv ───"
psql -c "select left(data->>'summary',120) as summary,
                data->>'summary_model' as model,
                case when embedding is null then null else vector_dims(embedding) end as emb_dims,
                jsonb_array_length(coalesce(data->'entities','[]')) as n_entities,
                (search_tsv is not null) as has_tsv
         from nodes where id='$N';"

echo ""; echo "── L4 profile: facts extracted from this node ───────────────"
psql -c "select kind, left(content,80) as content, confidence,
                (embedding is not null) as emb, (entity_id is not null) as linked
         from facts where source_node_id='$N' order by kind;"

echo ""; echo "── Graph: mentioned_in edges (entity → node) ────────────────"
psql -c "select e.kind, e.name
         from entity_edges ed join entities e on e.id=ed.source_id
         where ed.target_id='$N' and ed.relation='mentioned_in';"

echo ""; echo "── Observability: traces for this node ──────────────────────"
psql -c "select kind, status, coalesce(data->>'disposition','-') as disposition,
                cost_micro_usd, tokens_in, tokens_out, step_count,
                to_char(started_at,'MM-DD HH24:MI:SS') as started
         from traces where subject_id='$N' order by started_at;"

echo ""; echo "── Steps of the latest extractor_run ────────────────────────"
psql -c "select s.name, s.kind, s.status, coalesce(s.meta->>'model','') as model
         from trace_steps s join traces t on t.id=s.trace_id
         where t.subject_id='$N'
           and t.started_at=(select max(started_at) from traces where subject_id='$N' and kind='extractor_run')
         order by s.started_at;"

echo ""
echo "Signature guide (see docs/data-flow-tracing.md):"
echo "  summary set + facts>0 + edges>0 + extractor_run success  → healthy"
echo "  extractor_run skipped (body_too_short / already_extracted) → declined, by design"
echo "  extractor_run success but summary empty + 0 facts        → silent parse/empty miss"

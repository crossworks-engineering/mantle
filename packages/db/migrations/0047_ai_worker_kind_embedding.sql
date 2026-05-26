-- Add 'embedding' to the ai_worker_kind enum so users can manage their
-- embedding model as a first-class AI worker (alongside reflector,
-- extractor, summarizer, tts, stt, vision, image_gen).
--
-- Embedding usage is genuinely cross-cutting today (extractor write path,
-- agent semantic-memory reads, recall builtin, MCP search, tool-result
-- spill query) — the override-on-extractor field was misleading because
-- it covered only one of six call sites. Making it a worker gives one
-- canonical place to pick the model.
--
-- Lives in its own file because `ALTER TYPE ... ADD VALUE` is not
-- transactional with DDL that uses the new value — see migration 0008
-- (node_type_telegram) for the same shape. The journal's
-- `breakpoints: true` makes Drizzle commit between this migration and
-- whatever comes next.

alter type "public"."ai_worker_kind" add value if not exists 'embedding';

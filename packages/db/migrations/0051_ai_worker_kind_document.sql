-- Add 'document' to the ai_worker_kind enum so PDFs (and other documents) can
-- have their own dedicated AI worker, separate from image vision. The vision
-- model and the document model are usually picked differently — a cheap model
-- is fine for "describe this photo", but invoices/statements want a strong
-- document model (Claude / Gemini) sent the PDF natively. A dedicated worker
-- lets the operator configure each independently.
--
-- runDocumentWorker resolves kind='document' first and falls back to the
-- kind='vision' worker when none is configured, so this is purely additive —
-- nothing breaks if no document worker exists.
--
-- Lives in its own file because `ALTER TYPE ... ADD VALUE` is not transactional
-- with DDL that uses the new value (see 0047 ai_worker_kind_embedding). The
-- journal's `breakpoints: true` makes Drizzle commit between migrations.

alter type "public"."ai_worker_kind" add value if not exists 'document';

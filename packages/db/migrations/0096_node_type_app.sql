-- Adds 'app' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot be USED in the same transaction that adds
-- it (Postgres 55P04); the custom runner commits each migration separately, so
-- isolating the add lets 0097's `apps` sidecar reference type='app' safely.
-- Same reason as 0094 (location) and 0075 (lifelog).
--
-- An `app` node is a mini app authored by the Appsmith agent: real TSX bundled
-- by esbuild and rendered in a sandboxed iframe. Source + manifest + build
-- artifact pointers live in the `apps` sidecar (1:1 with the node), mirroring
-- how pages hang off their node.

alter type "public"."node_type" add value if not exists 'app';

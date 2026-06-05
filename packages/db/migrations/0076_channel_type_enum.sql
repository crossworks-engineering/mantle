-- Comms channels (docs/comms-channels.md): decouple transport from agents.role.
--
-- The `channel_type` enum lives in its OWN migration because Postgres forbids
-- using a newly-added enum value in the same transaction it was created, and
-- the migrate runner commits each migration separately (see migrate.ts header,
-- same reason as the 0008 / 0067 / 0075 enum migrations). 0077 creates the
-- `channels` table that references this type.
--
-- Only 'telegram' is wired today; 'discord' / 'slack' are added in their own
-- enum-add migrations when their pollers ship.

CREATE TYPE "public"."channel_type" AS ENUM ('telegram');

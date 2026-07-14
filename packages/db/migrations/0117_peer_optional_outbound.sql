-- Peer pairing: allow creating a peer BEFORE the other side has issued us a
-- token. "Add peer" now mints + reveals our inbound token with only a name and
-- base URL; the outbound token (the one THEY issue US) can be added later.
-- A peer without one sits in status='pending' — inbound requests still verify
-- (they authenticate with the token WE minted), only outbound calls are
-- disabled until the token arrives. Fixes the first-pairing deadlock where
-- each side needed the other's token to create the peer at all.

ALTER TABLE "mantle_peers" ALTER COLUMN "outbound_token_enc" DROP NOT NULL;

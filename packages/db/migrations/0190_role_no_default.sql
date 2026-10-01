-- auth.users.role has no default (client logins audit A14). Since 0162 the
-- column defaulted to 'admin', so any insert that forgot the role made an
-- ADMIN login. Every insert now names the role (first-run signup, Settings >
-- Logins, member invites, client logins); without one the insert fails on
-- NOT NULL instead of granting the most. Metadata only: no row changes, no
-- rewrite; the lock is short, and lock_timeout keeps it from queueing behind
-- a long reader.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "role" DROP DEFAULT;

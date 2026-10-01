-- Second layer of the read-only edge: a Postgres role that CANNOT write.
--
-- The Caddy layer refuses writes at the door, which is the layer visitors
-- actually meet. This one exists for the case that layer is wrong: a missed
-- method, a route that mutates on GET, a future Caddy edit that drops the
-- matcher. Defence in depth means the second layer must not depend on the
-- first being correct.
--
--   psql -f readonly-role.sql       (run as a superuser, once per demo brain)
--
-- Then point the SERVE-time app at the demo_reader role. Seeding still uses
-- the owner role — you cannot seed through a read-only connection, and that
-- asymmetry is the point.

-- Password is not a secret in any meaningful sense: the role can read a brain
-- of entirely fictional content and can write nothing. Kept simple so a
-- re-seed does not have to thread a generated password through the deploy.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'demo_reader') then
    create role demo_reader login password 'demo_reader_not_a_secret';
  end if;
end
$$;

-- Row security (migration 0159) filters every role that is neither the table
-- owner nor a superuser, and demo_reader is neither: without this its reads
-- come back empty. It reads the whole fictional brain as the owner would, so
-- it skips the row policies. The write revokes below still hold; BYPASSRLS
-- decides which rows it sees, not what it may do to them.
alter role demo_reader bypassrls;

grant connect on database postgres to demo_reader;

-- Read everything the app reads. `auth` matters: session verification looks
-- the user up there, so omitting it produces a login loop rather than a clean
-- error, which is a miserable thing to debug.
grant usage on schema public to demo_reader;
grant usage on schema auth to demo_reader;
grant select on all tables in schema public to demo_reader;
grant select on all tables in schema auth to demo_reader;

-- Sequences: some read paths call currval/nextval indirectly. SELECT on a
-- sequence is read-only; USAGE would permit nextval, so it is NOT granted.
grant select on all sequences in schema public to demo_reader;

-- A later migration must not silently hand the role write access, nor leave
-- new tables unreadable — both are failure modes that appear only after a
-- version bump.
alter default privileges in schema public grant select on tables to demo_reader;
alter default privileges in schema auth   grant select on tables to demo_reader;

-- Belt and braces: explicitly revoke write verbs, in case a future grant is
-- broader than intended.
revoke insert, update, delete, truncate on all tables in schema public from demo_reader;
revoke insert, update, delete, truncate on all tables in schema auth   from demo_reader;

-- pgboss is the job queue. The serve-time demo runs no workers, and a reader
-- that could enqueue would be a write path by another name.
revoke all on schema pgboss from demo_reader;

-- `mantle_brain_id()` names the brain's owner (resolveSingleOwnerId). Migration
-- 0189 took EXECUTE away from PUBLIC and gives it to demo_reader only when the
-- role already exists at migrate time, which it never does: this file runs
-- after the migrations, and a dump is taken without privileges. Without the
-- grant nothing errors: the appearance falls back to default branding and the
-- app-frame backdrop is dropped.
grant execute on function public.mantle_brain_id() to demo_reader;

-- The app has MORE connections than demo_reader since member logins (0159,
-- 0165): the level roles and the personal-space role, which migrate creates
-- and grants (`applyViewerGrants`). The space role may write the space
-- tables, so on a demo it would be a second way in that this file did not
-- cover. Every app connection on the demo is read-only: take the write verbs
-- from those roles too. Run this file AFTER migrate, which re-grants them.
do $$
declare r text;
begin
  foreach r in array array['mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke insert, update, delete, truncate on all tables in schema public from %I', r);
      execute format('revoke insert, update, delete, truncate on all tables in schema auth from %I', r);
    end if;
  end loop;
end
$$;

-- Proof that every database role the demo app can connect as is read-only.
--
--   psql -v ON_ERROR_STOP=1 -f readonly-check.sql     (as a superuser)
--
-- readonly-role.sql MAKES the roles read-only; this file CHECKS it, and raises
-- when it is not so. They are two files because the claim breaks without
-- anyone touching the first one: every `migrate` re-grants INSERT, UPDATE and
-- DELETE on the space tables to mantle_view_space (applyViewerGrants in
-- packages/db), so a migrate that is not followed by readonly-role.sql leaves
-- a writable role behind while every screen still works. check-readonly.sh
-- tests the HTTP edge only; this is the same question asked of the database.
-- demo/deploy/migrate-readonly.sh is the one way to migrate: it runs both.
do $$
declare
  roles constant text[] := array['demo_reader', 'mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'];
  bad text;
  missing text;
begin
  select string_agg(r, ', ') into missing
    from unnest(roles) r where not exists (select 1 from pg_roles where rolname = r);
  if missing is not null then
    raise exception 'read-only check: role(s) missing: %. Run migrate, then readonly-role.sql.', missing;
  end if;

  select string_agg(format('%s may %s %I.%I', r.rolname, p.priv, n.nspname, c.relname), '; ' order by r.rolname, c.relname, p.priv)
    into bad
    from pg_roles r
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
    join pg_class c on c.relkind in ('r', 'p')
    join pg_namespace n on n.oid = c.relnamespace and n.nspname in ('public', 'auth')
   where r.rolname = any (roles)
     and has_table_privilege(r.oid, c.oid, p.priv);
  if bad is not null then
    raise exception 'NOT read-only: %', left(bad, 900);
  end if;

  if exists (select 1 from pg_roles where rolname = any (roles) and (rolsuper or rolcreaterole or rolcreatedb)) then
    raise exception 'NOT read-only: one of the app roles is a superuser or may create roles or databases';
  end if;
  if has_schema_privilege('demo_reader', 'pgboss', 'USAGE') then
    raise exception 'NOT read-only: demo_reader may use the pgboss schema (it could enqueue jobs)';
  end if;

  -- And it must still be able to READ, or the check passes on a broken demo.
  if not has_table_privilege('demo_reader', 'public.nodes', 'SELECT')
     or not (select rolbypassrls from pg_roles where rolname = 'demo_reader') then
    raise exception 'demo_reader cannot read the brain (no SELECT on nodes, or no BYPASSRLS): run readonly-role.sql';
  end if;
  if not has_function_privilege('demo_reader', 'public.mantle_brain_id()', 'EXECUTE') then
    raise exception 'demo_reader may not execute mantle_brain_id(): run readonly-role.sql';
  end if;
end
$$;
select 'read-only check ok: demo_reader and the four level roles hold no write right on any table in public or auth';

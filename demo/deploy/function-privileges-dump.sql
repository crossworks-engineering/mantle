-- Writes the EXECUTE rights of the brain's restricted functions as SQL.
--
--   psql -At -f function-privileges-dump.sql > function-privileges.sql   (pack.sh does this)
--
-- The dump is taken with --no-privileges (so demo_reader's grants are made on
-- the box, against the schema that landed). That also drops every REVOKE
-- EXECUTE ... FROM PUBLIC the migrations made (0169, 0180, 0186, 0189, 0194,
-- 0195, 0200 and whatever comes next), so on the box those functions would be
-- executable by any role. Naming them here by hand would go stale with the
-- next migration; this reads them from the catalog of the brain being packed.
--
-- A function is "restricted" when its ACL does not give EXECUTE to PUBLIC.
-- For each one: take EXECUTE from PUBLIC, then give it back to each role the
-- bench gives it to, when that role exists on the box.
set search_path = '';
with restricted as (
  select p.oid, p.proacl
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proacl is not null
     and not exists (
       select 1 from pg_catalog.aclexplode(p.proacl) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')
)
select 'REVOKE ALL ON FUNCTION ' || oid::pg_catalog.regprocedure || ' FROM PUBLIC;'
  from restricted
union all
select pg_catalog.format(
         'DO $f$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %L) THEN GRANT EXECUTE ON FUNCTION %s TO %I; END IF; END $f$;',
         r.rolname, x.oid::pg_catalog.regprocedure, r.rolname)
  from restricted x
  cross join lateral pg_catalog.aclexplode(x.proacl) a
  join pg_catalog.pg_roles r on r.oid = a.grantee
 where a.privilege_type = 'EXECUTE' and not r.rolsuper
 order by 1 desc;

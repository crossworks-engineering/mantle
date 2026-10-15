-- mantle_owner_role() (0241, the derivation's guards) asks whether the
-- current role is a member of the owner of mantle_acl_internal(), not
-- whether it holds that owner's rights (arch A9, docs/runtime-role.md).
--
-- With USAGE, the runtime role had to inherit the marker's owner to pass,
-- and so held the owner's rights on the marker: it could drop or alter it,
-- after which this function errors and every write guard fails. MEMBER is
-- true for any membership, with or without INHERIT and SET, so the runtime
-- role passes as a member that holds none of the owner's rights (migrate
-- grants it that way, runtime-role.ts). The superuser passes as before; the
-- owner of the tables passes (it owns the marker); the viewer roles, the
-- write role and the gap writer are no member and fail, as before.
--
-- One function replaced: no table touched, no lock on a table, no trigger,
-- no LLM work. Re-runnable.
CREATE OR REPLACE FUNCTION "public"."mantle_owner_role"()
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT pg_has_role(current_user,
                     (SELECT p.proowner FROM pg_proc p
                       WHERE p.oid = 'public.mantle_acl_internal()'::regprocedure),
                     'MEMBER')
$$;

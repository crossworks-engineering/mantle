# Rolling a box past v0.230.57: every mini app must be rebuilt

**Applies to any box whose apps were built before v0.230.57 (2026-08-14).**
Found on NATREF 2026-08-19, in the roll from v0.230.27 to v0.230.69.

## The symptom

Every mini app renders with **no stylesheet**. Padding, gaps, max-widths,
rounding — every Tailwind utility is inert. Layout still half-holds wherever the
app used inline `style={{…}}`, which is why the damage looks uneven across apps
and reads as "the padding is gone" rather than "the CSS is gone".

It hits the owner `/apps` screen and the member `/team` surfaces equally,
because the cause is the BUILD, not the surface.

## The cause

`fix(apps): compile per-app Tailwind CSS and serve it beside the bundle`
(v0.230.57) added a CSS sidecar to a build. The frame document serves `appCss`
from `build.css`, and `server/web/lib/app-frame.ts` says so plainly:

> the JS key plus the optional CSS sidecar (**absent on builds that predate
> per-app CSS**)

A build produced before that release has no `css` key. Nothing backfills it, and
nothing warns. Before the roll the app looked right; after it, the same
`published_build` row is served through a frame that expects a sidecar it does
not have.

## Check a box

```sql
select n.title,
       case when a.published_build ? 'css' then 'ok' else 'STYLELESS' end,
       left(coalesce(a.published_build->>'builtAt',''),10)
from apps a join nodes n on n.id = a.node_id
order by 2 desc, 1;
```

```bash
ssh <box> "docker exec mantle_pg psql -U postgres -d postgres -P pager=off -c \"<the query>\""
```

Any row reading `STYLELESS` with `published_build->>'ok' = 'true'` is affected.

## The fix

**Rebuild and republish each app on the new server.** From ≥ v0.230.70 that is
two calls per app, and neither touches the code:

1. `app_build` — with no draft staged it compiles the PUBLISHED source, so the
   bundle is byte-equivalent apart from the new sidecar.
2. `app_publish` — promotes that rebuild.

⚠ **On v0.230.57 → v0.230.69 this does not work.** `publishApp` returned early
when no draft source was staged, so the rebuild could not be promoted. On those
versions the workaround is to re-stage the app's own published source first —
`app_get {include_source:true}` → `app_source_set` with the identical files →
`app_build` → `app_publish`. Fixed in v0.230.70; see
`apps-build-staleness.test.ts` for the tripwire.

## Verify

`published_build ? 'css'` is true for every app, and the app renders styled in
BOTH the owner `/apps` screen and `/team`. Check both: the owner frame prefers
`draftBuild` and the member frame serves `publishedBuild` only, so a rebuild
that was never published looks fixed to the owner and stays broken for members.

## The general rule

Any change to what a build EMITS strands every existing build the same way.
Adding a source map, a second sidecar, a manifest — each one needs this note and
a fleet rebuild. The build artifact is versioned by nothing; only rebuilding
refreshes it.

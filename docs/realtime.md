# Realtime (live UI)

Server-rendered screens that repaint the instant their data changes — no manual
refresh. Built on the Postgres `LISTEN/NOTIFY` Mantle already uses for ingest:
migration 0018 fires `pg_notify('node_ingested', <id>)` on **every** `nodes`
insert. We bridge that channel to the browser over SSE.

## How it flows

```
nodes INSERT ──(trigger 0018)──▶ pg_notify('node_ingested', id)
        │
   lib/realtime.ts  ── one app-wide LISTEN (dedicated connection)
        │            looks up the node's {type, ownerId} once, fans out
        ▼
  /api/realtime  ── SSE stream, per-owner, optional ?types= filter
        │
   useRealtime(types, onChange)  ── EventSource hook (auto-reconnect)
        ▼
   router.refresh()  ── re-runs the server component → new data paints in
```

## Add live updates to a screen (one line)

In a client component, after its initial server data is in props:

```tsx
import { useRealtime } from '@/components/realtime/use-realtime';
// …
const router = useRouter();
useRealtime(['event'], () => router.refresh());
```

If the component freezes its props in `useState` (for optimistic edits), also
sync them so a refresh actually updates the view:

```tsx
useEffect(() => setRows(initialRows), [initialRows]);
```

`types` filters by `node_type` (`['event']`, `['email']`, `['note', 'file']`,
…); omit/empty for all. The events screen
(`app/(app)/events/events-client.tsx`) is the reference consumer.

## Notes & guarantees

- **Owner isolation** is enforced server-side in `/api/realtime` — a change for
  another owner is never emitted.
- **One DB connection total.** A single shared LISTENer serves every connected
  tab; the SSE route only adds an in-process subscriber. The listener is a
  `globalThis` singleton so Next.js dev HMR doesn't stack duplicates.
- **Self-healing.** `EventSource` auto-reconnects on drop; a 25s heartbeat
  comment keeps idle connections off proxy/idle timeouts.
- **Scope today:** two channels, both fanned out the same way —
  `node_ingested` (migration 0018 trigger, every `nodes` insert: events, notes,
  files, emails, telegram, …) and `node_indexed` (the extractor's explicit
  `notifyNodeIndexed` after it writes `data.summary` + `embedding`). The second
  is what makes a freshly-summarised file repaint live — the insert alone has no
  summary yet. Other pure column updates still won't notify; emit on
  `node_indexed` (or add a table+channel) from the code that does the update.

## Source of truth

| Concern | File |
|---|---|
| The `node_ingested` trigger | `packages/db/migrations/0018_node_ingested_trigger.sql` |
| The `node_indexed` notify (extractor) | `packages/db/src/notify.ts` (`notifyNodeIndexed`) |
| LISTEN bridge + fan-out (both channels) | `apps/web/lib/realtime.ts` |
| SSE endpoint | `apps/web/app/api/realtime/route.ts` |
| Client hook | `apps/web/components/realtime/use-realtime.ts` |
| Reference consumer | `apps/web/app/(app)/events/events-client.tsx` |

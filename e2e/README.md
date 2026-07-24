# e2e — the split's regression net

Playwright suite that drives a LIVE stack end-to-end. Written before the
server/client split (v0.200.0) so every phase of it lands against a green net.
One spec set, two topologies:

| Project | Meaning | When it runs |
|---|---|---|
| `same-origin` | client and server are one origin (the monolith, or the server app's own team/share/print surfaces) | CI on every PR + locally |
| `split` | client (owner UI) on its own origin, server on the canonical origin | gate for Phase 4+; auto-skipped while `E2E_CLIENT_URL` is unset/equal |

Specs: auth, pages CRUD, realtime SSE, `?at=` asset tokens, public share,
team-token entry, PDF export, `/app-runtime` CORS. Fixtures make specs
topology-blind — same-origin auth is the session cookie, split auth is the
kind-`'m'` bearer (localStorage contract in `lib/contract.ts`).

## Run it

```sh
pnpm e2e                 # full hermetic cycle: throwaway stack → suite → wipe
e2e/scripts/run-local.sh up     # keep a stack up while iterating…
e2e/scripts/run-local.sh test   # …run the suite against it
e2e/scripts/run-local.sh down   # wipe (down -v — data is disposable)
```

Against an existing box instead (careful — the suite CREATES/DELETES content):

```sh
E2E_SERVER_URL=https://box.example.com \
E2E_EMAIL=owner@example.com E2E_PASSWORD=… pnpm e2e:same
```

Split topology (post-Phase-4):

```sh
E2E_SERVER_URL=https://box.example.com \
E2E_CLIENT_URL=https://app.box.example.com \
E2E_EMAIL=… E2E_PASSWORD=… pnpm e2e:split
```

Fresh stacks bootstrap themselves through the REAL first-run path: signup →
onboarding saveKey (dummy OpenRouter key — saved regardless of probe) →
provision → finish. No DB backdoors; the integrity gates get exercised too.

`E2E_SKIP_PDF=1` skips the PDF spec on stacks without the browserless sidecar.

# Team Hub App SDK — authoring a custom `/team` hub

A brain can designate one published mini-app as its **team hub app**
(Team admin → "Hub app"). When designated, the `/team` shell renders that app
full-bleed in place of the built-in hub body. The shell keeps everything that
must be core — the member token gate, cookie minting/revocation, the
live-streaming Team Chat, and the in-hub briefing reader — and exposes them to
the app through a small, enumerated, host-mediated postMessage API.

The built-in hub remains the zero-config default, the fallback for every
broken state, and the reference implementation of this contract.

The SDK is deliberately **thin**: a hub app is an ordinary `/apps` mini-app
plus one namespace (`host.hub`). Everything privileged stays in the host; the
app is presentation + app-local state.

## How designation resolves

`/team` renders the app only when the whole chain is intact — otherwise the
built-in hub renders and nothing is broken for members:

```
prefs.teamHubAppId  →  app exists under this owner
                    →  green PUBLISHED build
                    →  active TEAM-mode share
```

Designation (the Team admin picker, or `PUT /api/team-admin/hub-app`) ensures
the app's share exists and is team-mode, then sets the pref. Undesignating
clears the pref only. Members are served the **published build only** — drafts
never leave the owner editor, and **publish = live**: content and design
changes ship via `app_source_set → app_build → app_publish` in minutes, with
no platform release.

## The sandbox (unchanged)

A hub app runs exactly as sandboxed as any mini-app: opaque-origin iframe
(`sandbox="allow-scripts"`), bundle inlined into srcdoc, `connect-src 'none'`
(no network of its own), no cookies, no secrets. Its ONLY egress is the
postMessage bridge. "Trusted app" means **host-mediated** — never unsealed.

Brokered calls go through the app's team-mode share routes, so the member's
identity is re-derived server-side on every call, membership liveness is
re-checked, and every access is logged per member.

## Module surface (all of it)

An app may import only the curated runtime — there is no `node_modules` in
the sandbox:

| Specifier | Provides |
|---|---|
| `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` | the one shared React |
| `@/components/ui/button` `card` `input` `label` `badge` `separator` | shadcn-style kit |
| `@/lib/utils` | `cn()` |
| `lucide-react` | icons (bundled per app, tree-shaken) |
| `@host` | the bridge — below |

The entry file default-exports the root component; mounting, the error
boundary, the ready signal and resize wiring are generated.

## `@host` for hub apps

```ts
import { host } from '@host';

// ── Every mini-app has these ────────────────────────────────────────
host.tools.call(slug, input);  // declared builtin tools only on team surfaces,
                               // dispatched under the owner, logged per member
host.db.query(sql, params);    // the app's OWN SQLite (manifest schema)
host.db.exec(sql, params);     // allowed for team members; logged per member
host.ui.notifyError(msg);
host.ui.onAnnotate(fn);

// ── Team-hub surface only ───────────────────────────────────────────
host.hub.get(): Promise<HubData>;   // REJECTS off the /team surface
host.hub.openChat(): void;          // shell switches to live Team Chat
host.hub.openBriefing(token): void; // shell opens the in-hub reader

type HubData = {
  siteName: string | null;   // brain's site-name pref
  memberName: string | null; // signed-in member's display name
  version: string;           // platform version (footer chrome)
  sections: Array<{          // = the owner's active team-mode page shares,
    token: string;           //   share-time ordered (same source as the
    title: string;           //   built-in hub's briefing cards)
    icon: string | null;
    summary: string | null;
    updatedAt: string;       // ISO
  }>;
  counts: Record<string, number>; // whitelisted coarse content counts,
                                  // zeros included — the app decides what to hide
};
```

Design rules, binding on any future additions:

- **Enumerated, host-mediated, data-down / intent-up.** The app never receives
  a capability object, token, or handle — it asks (`hub.get`) or signals
  intent (`hub.nav`); the shell performs the privileged act. New capabilities
  are new enumerated kinds in `apps/web/lib/app-bridge/protocol.ts`, mirrored
  in the `@host` kit string (`packages/app-build/src/kit.ts` — drift tripwire
  in `kit.test.ts`) — never a generic passthrough.
- **Chat and the reader stay shell views.** The app can open them, never
  embed, restyle, or intercept them. That keeps the streaming chat, cookie
  handling, and share gating out of app reach.
- **`openBriefing` only opens real sections.** The shell validates the token
  against the current `sections` list; arbitrary tokens are ignored.
- **`hub.get` is answered locally by the shell** from the `/api/team/hub`
  payload it already fetched — adding fields to `HubData` means adding them to
  that route, where they are gated and audited like everything else.

## Authoring rules

- **R1 — Theme tokens only.** Semantic Tailwind classes / `var(--…)` tokens,
  never hardcoded colours; literal class strings from fixed variant maps
  (Tailwind v4 — no dynamic class names). The shell pushes light/dark and
  colour-theme changes live; token-only apps re-theme with zero code.
- **R2 — Degrade gracefully off-hub.** `host.hub.get()` rejects in the owner
  editor and on ordinary shares. Catch that and render a labelled preview with
  representative placeholder data — this keeps the app previewable in `/apps`
  while it's being authored. Never gate the whole render on `hub.get`.
- **R3 — Viewport sizing.** The hub slot is a viewport frame: the app owns
  scroll (`h-full` + `overflow-y-auto` layouts); viewport-height utilities are
  real; no manual resize calls.
- **R4 — Member identity is display-grade, not auth-grade.** `memberName` is
  for greeting and *advisory* attribution in the app's SQLite. Do not build
  permission or integrity logic on it — the app runs in the member's browser.
  The tamper-proof audit trail is the host's per-member access log.
- **R5 — SQLite is for app-local state** (read acknowledgements, poll votes,
  per-section feedback, layout prefs) via a declared schema
  (`app_db_schema_set`, versioned DDL). Never mirror brain content into the
  app db — brain data comes from `hub.get` or declared tools.
- **R6 — Tools are a last resort.** Prefer `hub.get` (free, audited, no
  grants). Declare a builtin tool only when the hub genuinely needs data
  beyond `HubData`; team surfaces refuse non-builtin handlers, calls run under
  the owner, and destructive builtins run unconfirmed — declaring one is an
  explicit owner decision.
- **R7 — Content-in-code is correct here.** The hub app IS the content layer:
  what's-new tiles, copy, and layout belong in its source, because the source
  ships via `app_publish` in minutes.
- **R8 — No side channels.** No fetch/websockets (CSP blocks them anyway), no
  `window.parent` calls outside `@host`, no secrets or member tokens persisted
  to the app db. A missing capability is a protocol addition, not a workaround.

## Skeleton

```tsx
import * as React from 'react';
import { host } from '@host';
import { MessageCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Hub = {
  siteName: string | null; memberName: string | null; version: string;
  sections: { token: string; title: string; icon: string | null; summary: string | null; updatedAt: string }[];
  counts: Record<string, number>;
};

const PREVIEW: Hub = {
  siteName: 'Acme', memberName: 'Alice', version: 'preview',
  sections: [{ token: '', title: 'Sample briefing', icon: null, summary: 'Off-hub preview', updatedAt: '' }],
  counts: { page: 12, table: 3 },
};

export default function App() {
  const [hub, setHub] = React.useState<Hub | null>(null);
  const [preview, setPreview] = React.useState(false);
  React.useEffect(() => {
    host.hub.get().then(setHub).catch(() => { setPreview(true); setHub(PREVIEW); });
  }, []);
  if (!hub) return null;
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      {preview && (
        <p className="p-2 text-center text-xs text-muted-foreground">Preview — not on /team</p>
      )}
      <header className="mx-auto max-w-5xl p-6">
        <h1 className="text-2xl font-semibold">{hub.siteName ?? 'Team Hub'}</h1>
        <p className="text-muted-foreground">
          {hub.memberName ? `Welcome, ${hub.memberName}.` : 'Welcome.'}
        </p>
        <Button className="mt-4" onClick={() => host.hub.openChat()}>
          <MessageCircle /> Ask the brain
        </Button>
      </header>
      <main className="mx-auto grid max-w-5xl gap-4 p-6 sm:grid-cols-2">
        {hub.sections.map((s) => (
          <Card
            key={s.token}
            className="cursor-pointer transition-colors hover:border-primary/50"
            onClick={() => host.hub.openBriefing(s.token)}
          >
            <CardHeader><CardTitle>{s.icon ? `${s.icon} ` : ''}{s.title}</CardTitle></CardHeader>
            {s.summary ? (
              <CardContent className="text-sm text-muted-foreground">{s.summary}</CardContent>
            ) : null}
          </Card>
        ))}
      </main>
    </div>
  );
}
```

## Definition of done for a hub app

1. `app_build` green, `app_publish` done, designated in Team admin.
2. Renders correctly on `/team` as a real member, in light and dark.
3. Off-hub preview (R2) renders in the `/apps` editor.
4. Chat and every briefing open via `host.hub` and "back" returns to the app.
5. No hardcoded colours; no undeclared tool slugs; versioned SQLite schema.
6. Revoking the member's token locks them out mid-session (host guarantee —
   verify, don't assume).

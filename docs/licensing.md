# Licensing

Mantle is **dual-licensed** by Cross Works Engineering (Pty) Ltd. This page is the
in-app overview; the binding legal texts live at the repository root.

| File | What it is |
| --- | --- |
| `LICENSE.md` | Public **Functional Source License 1.1 (MIT Future)** — `FSL-1.1-MIT`. |
| `LICENSE-COMMERCIAL.md` | Paid **Commercial License Agreement** that overrides the FSL's Competing-Use restriction. |
| `LICENSING.md` | Plain-language **Explainer & Foreword** (the business rationale). |
| `THIRD-PARTY-NOTICES.md` | Attribution for every bundled open-source component. |

## The model in one paragraph

The **public FSL** keeps Mantle's source open and free for developers,
self-hosters, and internal business use, but blocks selling Mantle as a competing
product or service. Each released version automatically converts to the permissive
**MIT** license **two years** after it is first published (the FSL's _Grant of
Future License_). Companies that want to **embed** Mantle in a commercial product,
or offer a **competing service**, during that two-year window buy a **Commercial
License** — which gives them the latest features, security patches, and support in
exchange for a subscription fee.

```
[ Year 1: Active Release ] ──(FSL Shield: No Competing Use)──> [ Year 3: Converts to MIT ]
[ Year 2: Active Release ] ──(FSL Shield: No Competing Use)──> [ Year 4: Converts to MIT ]
```

## Key terms

- **Embedded Use** — bundling Mantle's code, APIs, or schemas inside your own
  commercial software. Needs a Commercial License during the FSL window.
- **Competing Use / Competing Service** — hosting Mantle and selling direct access
  to it (a "Mantle Cloud"). Restricted under the FSL; requires a negotiated
  commercial or revenue-share deal.
- **IP boundaries** — Cross Works Engineering (Pty) Ltd retains 100% ownership of
  the Mantle trademark, brand, and core codebase. A commercial licensee gets a
  right to use and modify for their integration, not ownership of the engine.
  Core improvements must be contributed back or kept as an external wrapper.

To get a commercial license, email **licensing@crossworks.engineering**.

## Third-party open-source components

Mantle's production build incorporates **613** third-party packages, each under
its own license. Every license is reproduced verbatim in
`THIRD-PARTY-NOTICES.md` (regenerate with `pnpm licenses:notices`). The breakdown:

| License | Packages |
| --- | ---: |
| MIT | 486 |
| Apache-2.0 | 66 |
| ISC | 31 |
| BSD-2-Clause | 10 |
| BSD-3-Clause | 8 |
| MIT-0 | 1 |
| 0BSD | 1 |
| Unlicense | 1 |
| CC-BY-4.0 | 1 |
| LGPL-3.0 | 1 |
| LGPL-3.0-or-later | 1 |
| Dual-licensed (taken as MIT) | 3 |
| Other (BSD, MIT AND ISC, MIT AND Zlib) | 3 |

**Copyleft note.** The only copyleft dependencies are LGPL (`libheif-js`,
`@img/sharp-libvips-*`), used unmodified as separate dynamically-loaded libraries —
their terms are satisfied by attribution and replaceability. Dual-licensed packages
(`jszip` MIT-or-GPL, `@zone-eu/mailsplit` MIT-or-EUPL) are used under their MIT
option. There are **no AGPL or strong-copyleft (GPL) obligations** on Mantle's own
code.

> Counts are a snapshot; `THIRD-PARTY-NOTICES.md` is the source of truth and is
> regenerated from the installed dependency tree.

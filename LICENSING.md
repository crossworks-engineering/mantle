# Mantle Licensing — Explainer & Foreword

This document is the Foreword and Explainer for the Mantle licensing model. It
translates the legal mechanics of our dual-licensing strategy into plain business
terms — how we protect our intellectual property while fostering an open,
collaborative ecosystem.

The binding legal texts live alongside this file:

- **[`LICENSE.md`](./LICENSE.md)** — the public Functional Source License 1.1
  (MIT Future), `FSL-1.1-MIT`.
- **[`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)** — the paid Commercial
  License Agreement that overrides the FSL's restrictions.
- **[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)** — attribution for the
  open-source components Mantle is built on.

> This explainer is a summary for orientation. Where it differs from `LICENSE.md`
> or `LICENSE-COMMERCIAL.md`, **those documents control.**

## 1. The Core Philosophy: "Fair-Code"

Mantle is built on the belief that software should be transparent, customizable,
and accessible. At the same time, we believe creators deserve to protect and
monetize their engineering effort.

To balance those two values, we use a **dual-license strategy**:

### 🛡️ The Shield — Public FSL

The Functional Source License (FSL) is our default public license. It keeps the
source code open and free for developers, self-hosters, and internal business
use, but blocks giant SaaS aggregators or competitors from selling Mantle as a
service.

### 🔑 The Key — Commercial License

The Commercial License Agreement is a paid contract that overrides the FSL's
restrictions. It is designed for partners who want to embed Mantle's engine into
their own commercial products, or distribute it as part of a closed-source, paid
offering.

## 2. Timeline Dynamics: The "Rolling" Open-Source Engine

One of the most elegant parts of this strategy is the timeline. The FSL uses a
**2-year rolling window** (the Production Use Grant Period). Here is how it works
in practice:

```
[ Year 1: Active Release ] ──(FSL Shield: No Competing Use)──> [ Year 3: Converts to MIT ]
[ Year 2: Active Release ] ──(FSL Shield: No Competing Use)──> [ Year 4: Converts to MIT ]
```

**How this affects commercial licensees:**

1. **During the 2-year window** — If a company wants to embed the latest version
   of Mantle into their commercial product, they must purchase and maintain the
   Commercial License.
2. **After the 2-year window** — The code for that specific version automatically
   converts to the fully permissive MIT license.
3. **The commercial incentive** — A licensee could theoretically stop paying and
   use the 2-year-old version under MIT terms, but they would lose access to the
   latest features, security patches, and performance updates — which are always
   protected under the active 2-year FSL window. This creates a natural,
   value-driven subscription model.

## 3. Explaining the Key Legal Terms

To keep our lawyer and our business partners on the same page, here is what our
core terms actually mean.

### A. What is "Embedded Use"?

- **What it is:** A company takes Mantle's code, APIs, or database schemas and
  bundles them inside their own commercial software (e.g. incorporating Mantle's
  knowledge-graph engine into a fleet-management suite).
- **Why it needs a commercial license:** The FSL restricts Competing Use. To
  legally ship Mantle inside a paid product during the 2-year window, the vendor
  needs our explicit permission, which we grant via the Commercial License in
  exchange for a fee.

### B. What is a "Competing Service"?

- **What it is:** Hosting Mantle and selling direct access to it as a hosted
  workspace, personal assistant, or database platform.
- **Our stance:** This is restricted under the FSL. If a company wants to run a
  "Mantle Cloud" competitor, they must negotiate a custom revenue-share or
  enterprise partnership with us.

### C. Intellectual Property (IP) Boundaries

- **The rule:** Cross Works Engineering (Pty) Ltd retains 100% ownership of the
  Mantle trademark, brand, and core codebase.
- **The grant:** The licensee is buying a right to use and modify the software
  for their specific integration. They do not own the underlying engine, and any
  core improvements they make to Mantle must either be contributed back or kept
  strictly as an external wrapper.

## ⚖️ The Win-Win Outcome

This structure ensures that individual developers and small operators can use and
run Mantle entirely for free, while commercial enterprises who profit from
embedding our technology contribute financially to the sustainability of the
project.

## How to get a commercial license

Email **licensing@crossworks.engineering** with a short description of how you
intend to embed or distribute Mantle. See [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)
for the full agreement.

# Process flow (the `flow` template)

Boxes and arrows drawn by a template: a process flow, a flowchart, an
architecture sketch, a data flow. Write the DATA below, never the SVG: the
template ranks the boxes, routes every arrow with right angles, measures
every label and draws it in the house style. For a type with no template,
use its own guide and draw by hand.

## When to use it

- A handful of steps or parts with arrows between them, read left to right
  or top to bottom.
- Not a timeline, a sequence of messages, a state machine or a chart: each
  has its own type (`diagram_types`).
- Over 9 boxes or 12 arrows: split it into an overview and a detail.

## Template data

`diagram_render` with `template: "flow"` and this data draws it and lists
what to fix; `present_create` saves it as a canvas; `present_export` writes
the SVG for a page.

| Field | What it is |
| --- | --- |
| `title` | required, up to 80 characters; drawn at the top unless `showTitle: false` |
| `description` | one sentence on what it shows (a warning when missing) |
| `direction` | `right` (default) or `down` |
| `nodes[]` | 1 to 40: `id`, `label` (wraps to 3 lines), `sublabel`, `tag` (a small caps line), `kind`, `shape`, `group` |
| `nodes[].kind` | `backend` (default), `focal`, `store`, `external`, `input`, `optional`, `security` |
| `nodes[].shape` | `box` (default), `pill`, `diamond`, `cylinder` |
| `edges[]` | up to 80: `from`, `to`, `label` (14 characters read best), `style` (`solid`, `dashed`), `tone` (`muted`, `accent`, `link`), optional `id` |
| `groups[]` | up to 12: `id`, `label`, `parent` (nesting), `kind` (`boundary`, `security`) |
| `legend` | `true` (default), `false`, or names: `{ "dashed": "Back to the data", "focal": "Main store" }` |

Budget (warnings): 9 nodes, 12 edges, 2 accent elements (focal nodes plus
accent edges). Errors: unknown fields, dangling ids, self loops, duplicate
ids, group loops. Every error names the field and the fix; the tool returns
them all at once.

A complete example (it draws as it stands):

```json
{
  "title": "How a message becomes memory",
  "description": "A message from chat or Telegram is stored, summarised and split into facts by local models, then indexed for recall.",
  "direction": "right",
  "groups": [
    {
      "id": "brain",
      "label": "The brain"
    },
    {
      "id": "local",
      "label": "Local models",
      "parent": "brain"
    }
  ],
  "nodes": [
    {
      "id": "chat",
      "label": "Web chat",
      "tag": "input",
      "kind": "input"
    },
    {
      "id": "telegram",
      "label": "Telegram bot",
      "tag": "input",
      "kind": "input"
    },
    {
      "id": "ingest",
      "label": "Ingest route",
      "sublabel": "POST /api/turn",
      "group": "brain"
    },
    {
      "id": "summarise",
      "label": "Summariser",
      "sublabel": "gemma, local",
      "group": "local"
    },
    {
      "id": "extract",
      "label": "Fact extractor",
      "sublabel": "gemma, local",
      "group": "local"
    },
    {
      "id": "store",
      "label": "Postgres + pgvector",
      "tag": "store",
      "kind": "focal",
      "shape": "cylinder",
      "group": "brain"
    },
    {
      "id": "recall",
      "label": "Recall",
      "sublabel": "search + rerank",
      "group": "brain"
    }
  ],
  "edges": [
    {
      "from": "chat",
      "to": "ingest",
      "label": "message"
    },
    {
      "from": "telegram",
      "to": "ingest",
      "label": "update"
    },
    {
      "from": "ingest",
      "to": "store",
      "label": "raw text"
    },
    {
      "from": "ingest",
      "to": "summarise",
      "style": "dashed",
      "label": "queue"
    },
    {
      "from": "ingest",
      "to": "extract",
      "style": "dashed",
      "label": "queue"
    },
    {
      "from": "summarise",
      "to": "store",
      "label": "summary"
    },
    {
      "from": "extract",
      "to": "store",
      "label": "facts"
    },
    {
      "from": "store",
      "to": "recall",
      "tone": "accent",
      "label": "embeddings"
    }
  ]
}
```

## Anti-patterns

- Every box focal: the accent is for one or two.
- Long arrow labels: 14 characters or fewer, or the arrows crowd.
- A box per sentence: merge boxes that always travel together.

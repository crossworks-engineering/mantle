/**
 * The non-GET routes an agent-driven request may write through (reviewed,
 * docs/agent-ui.md "The brain refuses, the window holds"): every other
 * non-GET row is refused by agentRefusesRow. agent-call.test.ts holds the
 * two together: a new non-GET row that agentRefusesRow does not refuse
 * fails until it is named here with why the agent may write it, or refused.
 * Read by that test only.
 *
 * Every write here still meets the body rules (a sharing, move or Admin
 * setting field, a `?ws=` target, a body over its ceiling: refused), and
 * runs with the person's own rights in the person's own window, where the
 * person watches it happen.
 */
const EDIT = 'a content edit of an item the person may edit, in the window they watch';
const CREATE = 'a new item where the person is, with their rights (a ?ws= target is refused)';
const DRAFT = "a draft's autosave: what everyone reads changes only on a commit (refused)";
const OWN = "the person's own view of the app, no one else's";

export const AGENT_ALLOWED_WRITES: Readonly<Record<string, string>> = {
  // Content edits.
  'PATCH /api/apps/:id': `${EDIT} (its MCP access, read-only data and trusted tools are refused by field)`,
  'PATCH /api/draws/:id': EDIT,
  'PATCH /api/events/:id': EDIT,
  'PATCH /api/files/files/:id': `${EDIT} (its indexing, a setting, is refused by field)`,
  'PATCH /api/files/folders/:id': `${EDIT} (its indexing, a setting, is refused by field)`,
  'PATCH /api/formulas/:id': EDIT,
  'PATCH /api/notes/:id': `${EDIT}; a write that replaces the note's whole content is held by the window for the person (client side)`,
  'PATCH /api/pages/:id': EDIT,
  'PATCH /api/presents/:id': `${EDIT} (its source, live code for every reader, is refused by field)`,
  'PATCH /api/tables/:id': EDIT,
  'PATCH /api/tasks/:id': EDIT,
  'PATCH /api/tree/:kind/folders/:id': EDIT,
  'PATCH /api/v1/pages/:id': EDIT,
  'PATCH /api/v1/tasks/:id': EDIT,
  'POST /api/tables/:id/draft-ops': `${EDIT} (its draft)`,
  'PUT /api/presents/:id/data': `${EDIT} (a canvas's own data store)`,
  // Drafts.
  'PUT /api/apps/:id/draft': DRAFT,
  'PUT /api/draws/:id/draft': DRAFT,
  'PUT /api/pages/:id/draft': DRAFT,
  'PUT /api/tables/:id/draft': DRAFT,
  // Creates.
  'POST /api/apps': CREATE,
  'POST /api/draws': CREATE,
  'POST /api/events': CREATE,
  'POST /api/files/files': `${CREATE}: an upload the person picked; its form fields are checked, a replace (an overwrite) and a parentPath are refused`,
  'POST /api/files/folders': CREATE,
  'POST /api/formulas': CREATE,
  'POST /api/notes': CREATE,
  'POST /api/pages': CREATE,
  'POST /api/presents': CREATE,
  'POST /api/tables': CREATE,
  'POST /api/tasks': CREATE,
  'POST /api/tree/:kind/folders': CREATE,
  'POST /api/v1/events': CREATE,
  'POST /api/v1/files': CREATE,
  'POST /api/v1/notes': CREATE,
  'POST /api/v1/pages': CREATE,
  'POST /api/v1/tasks': CREATE,
  // An app the person opens in the window: its code tools and its own data.
  'POST /api/apps/:id/build': `${OWN}: its draft built to run, nothing published`,
  'POST /api/apps/:id/format': `${OWN}: its draft's code formatted`,
  'POST /api/apps/:id/frame-ticket': `${OWN}: the ticket that opens its frame`,
  'POST /api/apps/:id/db-broker':
    "the app's own database calls as the person's click in it makes them (its tool broker is refused)",
  // The person's own place and marks.
  'POST /api/tree/items/:id/opened': 'the "opened" mark of an item the window opened',
  'PUT /api/tree/items/:id/pin': "the person's own pin of an item",
  'PUT /api/messenger/favourites/:kind/:id': "the person's own favourite mark of a chat",
  'POST /api/messenger/c/:id/read': 'marks a chat read for the person, nobody else sees a change',
  'POST /api/assistant/read': "marks the person's own assistant chat read",
  // The turn's own channel.
  'POST /api/assistant/turn/:turnId/cancel': "the turn's Stop (AGENT_OPEN_EXACT)",
  'POST /api/assistant/turn/:turnId/ui/:callId':
    "the window's answer to the turn's ui call (AGENT_OPEN_EXACT)",
};

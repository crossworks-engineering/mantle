import { describe, expect, it } from 'vitest';
import { flowForGroup, TOOL_FLOWS } from './flows';
import {
  buildToolCards,
  expandQuery,
  indexCards,
  rankTools,
  renderCatalog,
  summarize,
} from './rank';

const TOOLS = [
  {
    slug: 'email_send',
    description: 'Send an email to a contact on the allowlist. Needs to, subject and body.',
  },
  { slug: 'email_list', description: 'List recent emails in the inbox, newest first.' },
  {
    slug: 'event_create',
    description: 'Create a calendar event. A reminder is an event with a notify time.',
  },
  { slug: 'task_create', description: 'Create a task with a title, status and optional due date.' },
  {
    slug: 'table_row_add',
    description: 'Insert one row into a typed table. Takes `cells`, keyed by column.',
  },
  { slug: 'search_chunks', description: 'Semantic search over document passages.' },
];
const GROUPS = [
  {
    slug: 'email',
    name: 'Email',
    description: 'Send + read email',
    tools: ['email_send', 'email_list'],
  },
  { slug: 'events', name: 'Events', description: 'Calendar event CRUD', tools: ['event_create'] },
  { slug: 'tasks', name: 'Tasks', description: 'Task CRUD', tools: ['task_create'] },
  {
    slug: 'tables-rows',
    name: 'Table rows',
    description: 'Single-row inserts',
    tools: ['table_row_add'],
  },
  {
    slug: 'memory-core',
    name: 'Memory',
    description: 'Search the brain',
    tools: ['search_chunks'],
  },
];

describe('tool flows', () => {
  it('maps every group to one flow, unknown groups to other', () => {
    const seen = new Map<string, string>();
    for (const f of TOOL_FLOWS)
      for (const g of f.groups) {
        expect(seen.has(g), `group ${g} is in two flows`).toBe(false);
        seen.set(g, f.slug);
      }
    expect(flowForGroup('email')).toBe('people');
    expect(flowForGroup('some-mcp-connector')).toBe('other');
  });
});

describe('tool cards and ranking', () => {
  const cards = buildToolCards(TOOLS, GROUPS);
  const index = indexCards(cards);

  it('gives each tool the flow of its first group', () => {
    expect(cards.find((c) => c.slug === 'event_create')?.flow).toBe('plan');
    expect(cards.find((c) => c.slug === 'table_row_add')?.flow).toBe('tables');
  });

  it('cuts a summary on a sentence boundary', () => {
    const s = summarize(
      'First sentence is here and long enough to count. Second sentence. '.repeat(10),
      80,
    );
    expect(s.endsWith('.')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(80);
  });

  it('expands user words to card words', () => {
    expect(expandQuery('remind me')).toContain('event');
    expect(expandQuery('add a todo')).toContain('task');
  });

  it('ranks the action the user asks for first', () => {
    expect(rankTools(index, 'send a mail to John')[0]?.slug).toBe('email_send');
    expect(rankTools(index, 'remind me to call mom in 5 minutes')[0]?.slug).toBe('event_create');
    expect(rankTools(index, 'add this as a todo')[0]?.slug).toBe('task_create');
    expect(rankTools(index, 'log an expense row in my table')[0]?.slug).toBe('table_row_add');
  });

  it('uses the usage prior to break a near tie, and can scope to a flow', () => {
    const plain = rankTools(index, 'email');
    const withPrior = rankTools(index, 'email', { usage: { email_list: 500 } });
    expect(withPrior[0]?.slug).toBe('email_list');
    expect(plain.map((r) => r.slug)).toContain('email_send');
    expect(rankTools(index, 'email', { flow: 'plan' })).toEqual([]);
  });

  it('renders a stable names-only catalog', () => {
    const a = renderCatalog(cards, TOOL_FLOWS, new Set(['search_chunks']));
    const b = renderCatalog([...cards].reverse(), TOOL_FLOWS, new Set(['search_chunks']));
    expect(a).toBe(b);
    expect(a).toContain('email_list, email_send');
    expect(a).not.toContain('search_chunks');
  });
});

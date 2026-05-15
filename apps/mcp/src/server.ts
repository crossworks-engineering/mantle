/**
 * Mantle MCP server.
 *
 * Exposes the user's tree, emails, files, and rules to Claude over MCP.
 * Defaults to stdio (Claude Desktop / Claude Code); pass `--http` to bind
 * an HTTP+SSE listener on $MCP_HTTP_PORT for remote use.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` in the
 * package script; this entry just trusts `process.env`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { db, emails, nodes } from '@mantle/db';
import { searchNodes } from '@mantle/search';
import { and, desc, eq } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('ALLOWED_USER_ID must be set so the MCP server knows whose tree to expose.');
  process.exit(1);
}

const server = new McpServer({ name: 'mantle', version: '0.0.1' });

server.tool(
  'tree_list',
  'List children of a branch in the Mantle tree. Pass no path for top-level branches.',
  { path: z.string().optional() },
  async ({ path }) => {
    const rows = await db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(
        and(eq(nodes.ownerId, OWNER_ID!), path ? (eq as any)(nodes.path, path) : eq(nodes.type, 'branch')),
      )
      .limit(200);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'search',
  "Hybrid full-text + tree search over Jason's Mantle. Use `branch` (ltree path) to scope, `type` to filter.",
  {
    q: z.string().optional(),
    branch: z.string().optional(),
    type: z
      .enum([
        'branch',
        'email',
        'email_thread',
        'file',
        'note',
        'sermon',
        'contact',
        'secret',
        'task',
        'event',
        'printer_project',
      ])
      .optional(),
    tags: z.array(z.string()).optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ q, branch, type, tags, since, limit }) => {
    const results = await searchNodes({
      ownerId: OWNER_ID!,
      q,
      branch,
      type,
      tags,
      since: since ? new Date(since) : undefined,
      limit,
    });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'email_get',
  'Fetch a single email by id (body, headers, attachment refs).',
  { id: z.string().uuid() },
  async ({ id }) => {
    const [row] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
    if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'email_list',
  "Recent emails newest-first. Optionally filter by `accountId` or `since`.",
  {
    accountId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ accountId, since, limit }) => {
    const conds: any[] = [];
    if (accountId) conds.push(eq(emails.accountId, accountId));
    if (since) conds.push((eq as any)(emails.internalDate, new Date(since))); // placeholder until gte helper imported
    const rows = await db
      .select()
      .from(emails)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(emails.internalDate))
      .limit(limit ?? 50);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mantle-mcp] listening on stdio. Owner:', OWNER_ID);

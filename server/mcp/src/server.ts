/**
 * Mantle MCP server — stdio entry.
 *
 * Thin transport shell: resolve + validate the single local owner, build the
 * shared tool surface (`buildMantleMcpServer`, packages/mcp-core), and connect
 * over stdio. Claude Desktop / Claude Code spawn this process and talk to it
 * over JSON-RPC. The remote HTTP transport (apps/web/app/api/mcp) builds the
 * exact same surface from the same builder — change a tool in mcp-core, both
 * transports get it.
 *
 * Threat model: stdio means anyone who can spawn this process inherits the
 * owner's full data access. That's fine on your laptop and on a personal VPS
 * where you're the only shell user. The network exposure lives in the HTTP
 * transport, which gates on OAuth — never reachable from here.
 *
 * Owner is scoped by ALLOWED_USER_ID; at startup we verify the value is a real
 * UUID AND that the row exists in auth.users — typoing the env to a stranger's
 * UUID would otherwise silently surface their data.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` in the
 * package script; this entry just trusts `process.env`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authUsers, db, resolveSingleOwnerId } from '@mantle/db';
import { buildMantleMcpServer } from '@mantle/mcp-core';
import { eq } from 'drizzle-orm';

// Resolve the owner: ALLOWED_USER_ID when set (validated as a UUID inside
// resolveSingleOwnerId), else the sole auth.users row — so a self-hosted setup
// needs no env var. The MCP server is started on demand by Claude Desktop /
// Code, normally after the web-app account already exists; if it truly doesn't
// yet, exit with a clear message rather than scope every query to nothing.
const OWNER_ID = await resolveSingleOwnerId();
if (!OWNER_ID) {
  console.error(
    '[mantle-mcp] No account yet — create your account in the web app (signup), then reconnect the MCP server.',
  );
  process.exit(1);
}

// Verify the user actually exists. Without this, a stale ALLOWED_USER_ID would
// not error — it'd just scope every query to "user not found", returning empty
// results and accepting writes that no longer belong to any real owner. Cheap
// to check once at boot.
{
  const [existing] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, OWNER_ID))
    .limit(1);
  if (!existing) {
    console.error(
      `[mantle-mcp] ALLOWED_USER_ID ${OWNER_ID} does not match any auth.users row. ` +
        `Run the web UI signup or update .env.local.`,
    );
    process.exit(1);
  }
}

const server = buildMantleMcpServer(OWNER_ID);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mantle-mcp] listening on stdio. Owner:', OWNER_ID);

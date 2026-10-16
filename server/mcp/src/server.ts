/**
 * Mantle MCP server — stdio entry.
 *
 * Thin transport shell: resolve + validate the single local owner, build the
 * shared tool surface (`buildMantleMcpServer`, packages/mcp-core), and connect
 * over stdio. Claude Desktop / Claude Code spawn this process and talk to it
 * over JSON-RPC. The remote HTTP transport (server/web/app/api/mcp) builds the
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
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { bootSmokeExit, isBootSmoke } from '@mantle/config';
import {
  authUsers,
  db,
  openLoginWritePool,
  resolveSingleOwnerId,
  runAsSystem,
  startCallAudit,
} from '@mantle/db';
import { buildMantleMcpServer, ensureGateReady } from '@mantle/mcp-core';
import { registerRecallEmbedder } from '@mantle/content';
import { embedBatch } from '@mantle/embeddings';
import { eq } from 'drizzle-orm';
import { connectStdioAs, stdioOwnerActor } from './stdio-actor';

// Recall's embedder. @mantle/content is storage and does not depend on the
// adapter layer, so each process injects one at boot (see
// packages/content/src/embed-bridge.ts). stdio reaches page writes through the
// same page tools the other transports use, so a map committed from Claude
// Desktop must embed its prompts too.
// recall-embed-registration.test.ts pins this call in all three entrypoints.
registerRecallEmbedder(embedBatch);

// The one gate (arch A3c fix round 2, M-A): every narrower registered, or
// the server stops here at boot (ensureGateReady throws), not at its first
// tool call.
// gate-boot.test.ts pins this call in every process entry.
ensureGateReady();
// Boot smoke (scripts/boot-smoke.mjs): every import above linked and the
// gate is ready; exit 0 before the audit, the owner lookup or the transport.
if (isBootSmoke()) await bootSmokeExit('mcp-stdio');
// One audit row for every tool write (A5 step 6d, @mantle/db call-audit.ts).
startCallAudit();
// Arch A2b2b: each call runs in the anchor login's turn scope (mcp-core
// mcp-scope.ts), so its writes go to the write role as the HTTP MCP
// surface's do, and the database's write and edit checks hold them to that
// scope (docs/actors.md, "The login write gateway"). A small pool: one
// client's calls, and the role's 20 connections are the whole box's
// (connection-ceiling.test.ts).
openLoginWritePool({ max: 2 });

// Resolve the owner: ALLOWED_USER_ID when set (validated as a UUID inside
// resolveSingleOwnerId), else the sole auth.users row — so a self-hosted setup
// needs no env var. The MCP server is started on demand by Claude Desktop /
// Code, normally after the web-app account already exists; if it truly doesn't
// yet, exit with a clear message rather than scope every query to nothing.
// Arch A2a: the boot reads run as system(boot:mcp-stdio).
const OWNER_ID = await runAsSystem('boot:mcp-stdio', () => resolveSingleOwnerId());
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
  const [existing] = await runAsSystem('boot:mcp-stdio', () =>
    db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, OWNER_ID)).limit(1),
  );
  if (!existing) {
    console.error(
      `[mantle-mcp] ALLOWED_USER_ID ${OWNER_ID} does not match any auth.users row. ` +
        `Run the web UI signup or update .env.local.`,
    );
    process.exit(1);
  }
}

// Arch A2a: every message runs as the owner login this process is started
// for, login(owner), never system.
const server = buildMantleMcpServer(OWNER_ID);
const transport = new StdioServerTransport();
await connectStdioAs(stdioOwnerActor(OWNER_ID), server, transport);
console.error('[mantle-mcp] listening on stdio. Owner:', OWNER_ID);

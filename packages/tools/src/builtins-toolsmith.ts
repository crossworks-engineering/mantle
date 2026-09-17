/**
 * Toolsmith tool set — lets an agent author, test, group, and grant
 * templated HTTP API tools. The same capability is mirrored by the MCP
 * server (server/mcp) so Claude Code/Desktop can drive it on the user's
 * own subscription; keep semantics in sync.
 *
 * The intended loop: web_fetch the service's API docs → api_tool_create
 * with {param} templates + {{secret:service/label}} vault refs →
 * api_tool_test against the live API → tool_group_ensure →
 * agent_grant_tool_group. One prompt, a deployed ability.
 *
 * Security stances (deliberate, mirrored in server/mcp):
 *   - Agents author HTTP tools ONLY. Shell tools stay human-authored.
 *   - api_tool_test refuses non-http targets — otherwise "testing" a
 *     shell/builtin tool would be an unconfirmed execution side-channel.
 *   - api_key_refs returns masked previews + ref strings, never plaintext.
 *     (Dispatch decrypts refs server-side; see http-template.ts.)
 */

import type { BuiltinToolDef } from './types';
import { web_fetch } from './toolsmith/web-fetch';
import {
  api_tool_list,
  api_tool_get,
  api_tool_create,
  api_tool_update,
  api_tool_delete,
  api_tool_test,
  api_key_refs,
} from './toolsmith/api-tools';
import { api_docs_set, api_docs_get, api_skill_set } from './toolsmith/docs';
import { tool_catalog, recipe_tool_create, recipe_tool_test } from './toolsmith/recipes';
import {
  tool_group_list,
  tool_group_ensure,
  agent_list,
  agent_grant_tool_group,
} from './toolsmith/groups';

export const TOOLSMITH_TOOLS: BuiltinToolDef[] = [
  web_fetch,
  api_tool_list,
  api_tool_get,
  api_tool_create,
  api_tool_update,
  api_tool_delete,
  api_tool_test,
  api_key_refs,
  api_docs_set,
  api_docs_get,
  api_skill_set,
  tool_catalog,
  recipe_tool_create,
  recipe_tool_test,
  tool_group_list,
  tool_group_ensure,
  agent_list,
  agent_grant_tool_group,
];

/** The full set, granted to the Toolsmith specialist via its tool group. */
export const TOOLSMITH_TOOL_SLUGS: readonly string[] = TOOLSMITH_TOOLS.map((t) => t.slug);

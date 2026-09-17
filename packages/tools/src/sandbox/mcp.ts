/**
 * Driving an MCP server running inside a sandbox: list its tools, call one.
 *
 * Split out of builtins-sandbox.ts; bodies moved verbatim.
 */

import { getSandboxByRef, touchSandbox } from '@mantle/content';
import { notFound } from '../errors';
import { capOutput } from '../output-cap';
import type { BuiltinToolDef, ToolHandlerResult } from '../types';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, sandboxd } from './common';

export const sandbox_mcp_tools: BuiltinToolDef = {
  slug: 'sandbox_mcp_tools',
  readOnly: true,
  name: 'List sandbox toolbelt',
  description:
    "List the tools of the sandbox's embedded Claude Code MCP server (Read, Grep, Glob, Edit, " +
    'Write, Bash, …) — name and a short description each; pass `tool` for one full input ' +
    'schema. The serve process starts on first use (no API key involved). Prefer the toolbelt ' +
    'over raw `sandbox_exec` for file work: its Read/Edit/Grep are structured and validated.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      tool: {
        type: 'string',
        description:
          'Return the full definition (with input schema) of this one tool, e.g. "Bash".',
      },
    },
    required: ['sandbox'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const res = await sandboxd('POST', `/sandboxes/${row.id}/mcp`, { method: 'tools/list' });
    if (!res.ok) return res;
    await touchSandbox(row.id);
    const tools = Array.isArray((res.data.result as Record<string, unknown>)?.tools)
      ? ((res.data.result as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      : [];
    const want = typeof input.tool === 'string' ? input.tool : null;
    if (want) {
      const t = tools.find((x) => x.name === want);
      if (!t) {
        return {
          ok: false,
          error: `toolbelt has no tool '${want}' — list the real names with sandbox_mcp_tools (no \`tool\` arg)`,
        };
      }
      return { ok: true, output: { tool: t } };
    }
    return {
      ok: true,
      output: {
        tools: tools.map((t) => ({
          name: t.name,
          description: String(t.description ?? '').slice(0, 160),
        })),
      },
    };
  },
};

export const sandbox_mcp_call: BuiltinToolDef = {
  slug: 'sandbox_mcp_call',
  name: 'Call sandbox toolbelt',
  description:
    "Invoke one tool of the sandbox's Claude Code toolbelt (names + schemas from " +
    '`sandbox_mcp_tools`) and return its content. Runs INSIDE the sandbox — same blast radius ' +
    'as `sandbox_exec`, richer ergonomics: `Read` returns numbered lines, `Edit` validates its ' +
    'match, `Grep`/`Glob` search structurally. For plain shell commands `sandbox_exec` is ' +
    'equivalent and simpler. Long operations: raise `timeout_seconds`.',
  inputSchema: {
    type: 'object',
    properties: {
      sandbox: { type: 'string', description: 'Sandbox name or id.' },
      tool: { type: 'string', description: 'Toolbelt tool name, e.g. "Read" or "Bash".' },
      arguments: {
        type: 'object',
        description: 'Arguments per the tool\'s schema, e.g. {"file_path": "/files/x.py"}.',
        additionalProperties: true,
      },
      timeout_seconds: {
        type: 'number',
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        default: DEFAULT_TIMEOUT_S,
        description: 'Fail the call after this many seconds.',
      },
    },
    required: ['sandbox', 'tool'],
    additionalProperties: false,
  },
  requiresConfirm: false,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = typeof input.sandbox === 'string' ? input.sandbox : '';
    const row = await getSandboxByRef(ctx.ownerId, ref);
    if (!row) return notFound('sandbox', ref, 'sandbox_list');
    const tool = typeof input.tool === 'string' ? input.tool : '';
    if (!tool) return { ok: false, error: 'tool is required — list names with sandbox_mcp_tools' };
    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_S,
      Math.max(
        1,
        typeof input.timeout_seconds === 'number' ? input.timeout_seconds : DEFAULT_TIMEOUT_S,
      ),
    );
    ctx.step?.setMeta({ sandboxId: row.id, sandbox: row.name, mcpTool: tool, timeoutSeconds });

    const res = await sandboxd('POST', `/sandboxes/${row.id}/mcp`, {
      method: 'tools/call',
      params: { name: tool, arguments: input.arguments ?? {} },
      timeoutSeconds,
    });
    if (!res.ok) return res;
    await touchSandbox(row.id);

    const result = (res.data.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    const out = capOutput(text);
    ctx.step?.setOutput({ isError: result.isError === true, bytes: text.length });
    return {
      ok: true,
      output: {
        sandbox: row.name,
        tool,
        isError: result.isError === true,
        content: out.text,
        truncated: out.truncated,
      },
    };
  },
};

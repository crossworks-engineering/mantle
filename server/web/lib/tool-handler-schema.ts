/**
 * Shared Zod schema for the `tools.handler` jsonb column — one source of
 * truth for POST /api/tools and PATCH /api/tools/{id}.
 *
 * The http kind carries request templates: `{param}` placeholders are
 * filled from the tool-call input at dispatch time, `{{secret:service/label}}`
 * refs are decrypted from the api_keys vault server-side (see
 * packages/tools/src/http-template.ts for the exact substitution rules).
 */

import { z } from 'zod';

const TemplateValue = z.string().max(4000);

export const ToolHandlerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), ref: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal('http'),
    // Not z.string().url(): templates like https://api.x.com/{path}.json
    // must pass. Require an http(s) scheme and no whitespace instead.
    url: z
      .string()
      .min(1)
      .max(2000)
      .regex(/^https?:\/\/\S+$/i, 'url must start with http(s):// and contain no spaces'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    headers: z.record(z.string().min(1).max(200), TemplateValue).optional(),
    query: z.record(z.string().min(1).max(200), TemplateValue).optional(),
    body: z.string().max(20_000).nullable().optional(),
    headersRef: z.string().nullable().optional(),
    authRef: z.string().nullable().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('shell'),
    cmd: z.string().min(1).max(8000),
  }),
  // Present so a client echoing a row's handler back doesn't 400 on the
  // discriminator. Creating/patching INTO these kinds is refused in
  // @mantle/tools crud (mcp rows belong to their connector's sync).
  z.object({
    kind: z.literal('mcp'),
    group: z.string().min(1).max(120),
    toolName: z.string().min(1).max(200),
    vanishedAt: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('recipe'),
    steps: z
      .array(
        z.object({
          tool: z.string().min(1).max(120),
          input: z.record(z.string(), z.unknown()).optional(),
          as: z.string().max(60).optional(),
        }),
      )
      .min(1)
      .max(20),
    output: z.unknown().optional(),
  }),
]);

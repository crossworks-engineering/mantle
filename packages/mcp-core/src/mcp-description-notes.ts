/**
 * Lines the MCP surface adds to a builtin's description, and only there.
 *
 * A builtin's description is shared: the brain's agents and the MCP list
 * read the same text. An outside MCP client has none of the brain's skills,
 * so a few tools carry one more line for it. The brain-side text stays as it
 * is (owner, 2026-11-16, "Yes, MCP only": the assistants hold present_create
 * without design_guide, so the pointer there would name a tool they cannot
 * call). Applied where the surface takes a builtin's description
 * (gated-tools.ts); pinned by app-guidance.test.ts.
 */
const DESIGN_POINTER =
  "Before you build, read `design_guide` with `topic` ('mini-app', 'dashboard', 'deck' or 'landing-page').";

export const MCP_DESCRIPTION_NOTES: Readonly<Record<string, string>> = Object.freeze({
  app_create: DESIGN_POINTER,
  present_create: DESIGN_POINTER,
});

/** A builtin's description as the MCP surface lists it. */
export function mcpBuiltinDescription(slug: string, description: string): string {
  const note = MCP_DESCRIPTION_NOTES[slug];
  return note ? `${description} ${note}` : description;
}

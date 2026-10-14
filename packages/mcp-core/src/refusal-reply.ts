/**
 * An MCP reply that refuses the call: `Error: <text>`, flagged isError. Its
 * own module (A5 step 4 fix round 1, LOW-6) so gate-policy.ts and the one
 * registration (gated-tools.ts, which loads gate-policy.ts for its policy
 * source) do not import each other.
 */
export function refusalReply(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

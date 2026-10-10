import type { ToolModelImage } from '@mantle/tools';

/** MCP content blocks a tool reply carries. */
export type McpTextContent = { type: 'text'; text: string };
export type McpImageContent = { type: 'image'; data: string; mimeType: string };

/**
 * A text reply with the tool's pictures for the caller appended as MCP image
 * blocks (`modelImages`, e.g. `draw_get` with `image: true`). The JSON stays
 * the first block: guards and clients that read `content[0].text` see the
 * reply they always did.
 */
export function withModelImages(
  reply: { content: McpTextContent[] },
  images: readonly ToolModelImage[] | undefined,
): { content: Array<McpTextContent | McpImageContent>; isError?: boolean } {
  if (!images?.length) return reply;
  return {
    ...reply,
    content: [
      ...reply.content,
      ...images.map((i) => ({ type: 'image' as const, data: i.base64, mimeType: i.mimeType })),
    ],
  };
}

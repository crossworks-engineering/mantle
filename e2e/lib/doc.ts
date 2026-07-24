/**
 * Minimal ProseMirror doc for POST /api/pages (its CreateBody takes `doc`,
 * not markdown). Share presenters render the BODY, not the page name (repo
 * convention: pages meant for share surfaces carry their own `# title`), so
 * the title goes in as an H1 block. Block ids are self-healed server-side
 * (ensureBlockIds) — no need to mint them here.
 */
export function makeDoc(title: string, body: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: title }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: body }],
      },
    ],
  };
}

import { DrawDetailClient } from './draw-detail-client';

/**
 * /draw/[id] — the whiteboard editor (auth gate only). The draw row is
 * client-fetched via `GET /api/draws/[id]`; the canvas, its scene restore and
 * the draft machinery all live in the client component.
 */
export default async function DrawEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DrawDetailClient drawId={id} />;
}

/**
 * A drawing's indexed text (`draws.scene_text`): its own labels, frames and
 * relations (sceneToText), and one plain marker for each image it places
 * (always fold, workspaces plan 5.3, phase W2). An image's words (vision,
 * OCR) are indexed on the image's own file node and found through its own
 * level or grants, never through the drawing. Pure.
 */
import { drawPlacedFileIds } from './embed-closure';
import { drawEmbedMarkers } from './embed-fold';
import { sceneToText } from './scene-to-text';

export function drawSceneText(scene: Record<string, unknown>, fileRefs: unknown): string {
  const base = sceneToText(scene);
  const markers = drawEmbedMarkers(drawPlacedFileIds(scene, fileRefs));
  return markers ? (base ? `${base}\n\n${markers}` : markers) : base;
}

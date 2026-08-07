import { DrawScaffold } from './draw-scaffold';

/**
 * /draw — the whiteboard workspace. PHASE 0 SCAFFOLD: mounts a bare canvas
 * to prove the Excalidraw integration (self-hosted fonts, theme wiring,
 * lazy chunk isolation). Phase 2 replaces this with the master-detail list
 * + /draw/[id] editor over the Phase 1 API.
 */
export default function DrawPage() {
  return <DrawScaffold />;
}

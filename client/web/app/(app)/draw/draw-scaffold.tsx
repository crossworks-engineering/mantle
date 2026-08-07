'use client';

import { ExcalidrawCanvas } from '@/components/draw/excalidraw-canvas';

/** Phase 0 gate scaffold: a full-height canvas, nothing else. */
export function DrawScaffold() {
  return (
    <div className="h-[calc(100vh-8rem)] min-h-[24rem]">
      <ExcalidrawCanvas />
    </div>
  );
}

/** The pixel size of a PNG from its IHDR chunk, or null when the bytes are
 *  not a PNG. The engine's screenshots are PNG; a Word export sizes the
 *  picture at 1x from this (the raster itself is deviceScaleFactor times
 *  larger). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== sig[i]) return null;
  // bytes 12..15 are the chunk type 'IHDR'; width and height follow.
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

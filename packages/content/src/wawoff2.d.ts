// wawoff2 ships no types. Google's woff2 codec compiled to wasm: `decompress`
// turns a woff2 font into the plain sfnt (TTF/OTF) bytes it wraps.
declare module 'wawoff2' {
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>;
  export function compress(sfnt: Uint8Array): Promise<Uint8Array>;
}

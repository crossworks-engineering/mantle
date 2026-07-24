/** Stopwatch-style elapsed label for in-flight activity rows. Pure + dependency-
 *  free so it's unit-testable (the live-column component imports it). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const sec = s % 60;
  const min = Math.floor(s / 60) % 60;
  const hr = Math.floor(s / 3600);
  return hr > 0 ? `${hr}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

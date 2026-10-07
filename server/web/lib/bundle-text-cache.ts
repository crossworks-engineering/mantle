/**
 * Built app bundles held as text in memory, by storage key (apps audit P3).
 * Opening an app read its bundle (and CSS sidecar) back from object storage on
 * every frame load. The keys are content-addressed (sha256 of the bytes), so a
 * key's text never changes and can be kept without any invalidation: a new
 * build is a new key. Bounded by total characters; the least recently used
 * entries go first.
 */

/** About 32 MB of bundle text: dozens of typical apps. */
export const BUNDLE_TEXT_CACHE_MAX_CHARS = 32 * 1024 * 1024;

export class BundleTextCache {
  private readonly entries = new Map<string, string>();
  private chars = 0;

  constructor(private readonly maxChars = BUNDLE_TEXT_CACHE_MAX_CHARS) {}

  /** The cached text, or the loaded one (cached when it fits). A failed load
   *  is not cached. */
  async get(key: string, load: () => Promise<string>): Promise<string> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      // Most recently used goes to the end.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const text = await load();
    this.put(key, text);
    return text;
  }

  private put(key: string, text: string): void {
    if (text.length > this.maxChars || this.entries.has(key)) return;
    this.entries.set(key, text);
    this.chars += text.length;
    for (const [oldKey, oldText] of this.entries) {
      if (this.chars <= this.maxChars) break;
      this.entries.delete(oldKey);
      this.chars -= oldText.length;
    }
  }

  /** Entries and characters held (tests and diagnostics). */
  size(): { entries: number; chars: number } {
    return { entries: this.entries.size, chars: this.chars };
  }
}

/**
 * Deterministic per-agent accent + initials. Pure and dependency-free, so it
 * works in both server components (the /assistant header) and client ones (the
 * chat bubbles). Seeded by the agent slug so the same agent always gets the
 * same colour — that's the visual cue that you've switched who you're talking
 * to. Colours are emitted as HSL strings for inline styles (the dynamic hue
 * can't be a static Tailwind class).
 */

export type AgentAccent = {
  hue: number;
  /** Strong fill — avatar background. White text reads on it. */
  solid: string;
  /** Faint wash — bubble tint / header chip background. */
  soft: string;
  /** Accent border / ring. */
  border: string;
};

export function agentAccent(seed: string): AgentAccent {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return {
    hue,
    solid: `hsl(${hue} 58% 45%)`,
    soft: `hsl(${hue} 70% 50% / 0.10)`,
    border: `hsl(${hue} 60% 50% / 0.45)`,
  };
}

/** 1–2 letter monogram for the avatar. */
export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

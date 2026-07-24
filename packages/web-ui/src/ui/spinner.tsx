import { cn } from '../lib/utils';

/**
 * Mantle spinner — a smooth indeterminate arc that both rotates and breathes
 * (the dash grows/shrinks), so it reads as alive rather than a flat rotating
 * ring. Themed via `currentColor` (defaults to `text-primary`); honours
 * `prefers-reduced-motion`. The keyframes live in globals.css (`mantle-spin*`).
 *
 * Use for any indeterminate wait — list loads (TanStack Query `isPending`),
 * button-internal spinners, etc.
 */
export function Spinner({
  size = 24,
  className,
  label = 'Loading',
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex text-primary', className)}>
      <svg
        className="mantle-spinner"
        width={size}
        height={size}
        viewBox="0 0 50 50"
        fill="none"
        aria-hidden
      >
        <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="5" opacity="0.15" />
        <circle
          className="mantle-spinner-arc"
          cx="25"
          cy="25"
          r="20"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

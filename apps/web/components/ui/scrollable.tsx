/**
 * Scrollable Component
 * A reusable wrapper that provides styled scrollbars or hidden scrollbars.
 * Use this for consistent scroll behavior across the app.
 */

import React from "react";
import { cn } from "@/lib/utils";

export type ScrollbarStyle = "hidden" | "thin" | "default";

interface ScrollableProps {
  children: React.ReactNode;
  /** Scrollbar style: "hidden" (no scrollbar), "thin" (minimal), "default" (browser default) */
  scrollbar?: ScrollbarStyle;
  /** Additional class names */
  className?: string;
  /** HTML element to render, defaults to div */
  as?: "div" | "section" | "aside" | "main" | "nav";
}

/**
 * Scrollable container with configurable scrollbar styling.
 * 
 * @example
 * // Hidden scrollbar
 * <Scrollable scrollbar="hidden" className="h-full">
 *   {content}
 * </Scrollable>
 * 
 * @example
 * // Thin scrollbar
 * <Scrollable scrollbar="thin" className="h-[400px]">
 *   {content}
 * </Scrollable>
 */
export function Scrollable({
  children,
  scrollbar = "thin",
  className,
  as: Component = "div",
}: ScrollableProps) {
  const scrollbarClass =
    scrollbar === "hidden"
      ? "scrollbar-hidden"
      : scrollbar === "thin"
      ? "scrollbar-thin"
      : "";

  return (
    <Component className={cn("overflow-y-auto", scrollbarClass, className)}>
      {children}
    </Component>
  );
}

/**
 * Global CSS for scrollbar styles.
 * Include this once in your app (e.g., in a layout or _app).
 */
export function ScrollbarStyles() {
  return (
    <style jsx global>{`
      /* Hidden scrollbar */
      .scrollbar-hidden {
        -ms-overflow-style: none;
        scrollbar-width: none;
      }
      .scrollbar-hidden::-webkit-scrollbar {
        display: none;
      }

      /* Thin scrollbar */
      .scrollbar-thin {
        scrollbar-width: thin;
        scrollbar-color: hsl(var(--muted-foreground) / 0.3) transparent;
      }
      .scrollbar-thin::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      .scrollbar-thin::-webkit-scrollbar-track {
        background: transparent;
      }
      .scrollbar-thin::-webkit-scrollbar-thumb {
        background-color: hsl(var(--muted-foreground) / 0.3);
        border-radius: 3px;
      }
      .scrollbar-thin::-webkit-scrollbar-thumb:hover {
        background-color: hsl(var(--muted-foreground) / 0.5);
      }

      /* Auto-hide scrollbar on thin (shows on hover/scroll) */
      .scrollbar-thin::-webkit-scrollbar-thumb {
        transition: background-color 0.2s ease;
      }
    `}</style>
  );
}

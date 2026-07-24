/**
 * Scrollable Component
 * A reusable wrapper that provides styled scrollbars or hidden scrollbars.
 * Use this for consistent scroll behavior across the app.
 */

import React from 'react';
import { cn } from '../lib/utils';

export type ScrollbarStyle = 'hidden' | 'thin' | 'default';

interface ScrollableProps {
  children: React.ReactNode;
  /** Scrollbar style: "hidden" (no scrollbar), "thin" (minimal), "default" (browser default) */
  scrollbar?: ScrollbarStyle;
  /** Additional class names */
  className?: string;
  /** HTML element to render, defaults to div */
  as?: 'div' | 'section' | 'aside' | 'main' | 'nav';
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
  scrollbar = 'thin',
  className,
  as: Component = 'div',
}: ScrollableProps) {
  const scrollbarClass =
    scrollbar === 'hidden' ? 'scrollbar-hidden' : scrollbar === 'thin' ? 'scrollbar-thin' : '';

  return (
    <Component className={cn('overflow-y-auto', scrollbarClass, className)}>{children}</Component>
  );
}

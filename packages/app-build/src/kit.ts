/**
 * The bundled-in module kit every mini app builds against. esbuild resolves the
 * app's `@/components/ui/*`, `@/lib/utils`, and `@host` imports to these sources
 * (served from memory by kitPlugin), so generated apps look native (same theme
 * tokens) and talk to the host over the bridge — with NO dependency on the
 * apps/web source tree or its node_modules at build time. React is bundled into
 * each app (each iframe is its own isolated document).
 *
 * These are SOURCE STRINGS (TSX/TS), not live modules. They are compiled ONCE
 * into the shared `/app-runtime` (see build-runtime.ts) and resolved at load time
 * via the iframe import map — apps mark `react`/`@host`/`@/components/ui/*`
 * external rather than re-bundling them. Keep them dependency-light (only `react`
 * + `react-dom/client` in @host) and theme-token-only (never hardcode colours),
 * matching apps/web/CLAUDE.md.
 */

/** `cn` — minimal class joiner (no clsx/tailwind-merge dep). Generated apps
 *  write clean class lists, so a plain truthy-join is enough. */
const UTILS = `
export function cn(...inputs) {
  return inputs.flat(Infinity).filter(Boolean).join(' ');
}
`;

const BUTTON = `
import * as React from 'react';
import { cn } from '@/lib/utils';
const VARIANTS = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
};
const SIZES = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-md px-3',
  lg: 'h-11 rounded-md px-8',
  icon: 'h-10 w-10',
};
export const Button = React.forwardRef(function Button(
  { className, variant = 'default', size = 'default', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant] || VARIANTS.default,
        SIZES[size] || SIZES.default,
        className,
      )}
      {...props}
    />
  );
});
Button.displayName = 'Button';
`;

const CARD = `
import * as React from 'react';
import { cn } from '@/lib/utils';
export const Card = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)} {...p} />
));
Card.displayName = 'Card';
export const CardHeader = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...p} />
));
CardHeader.displayName = 'CardHeader';
export const CardTitle = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('font-semibold leading-none tracking-tight', className)} {...p} />
));
CardTitle.displayName = 'CardTitle';
export const CardDescription = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...p} />
));
CardDescription.displayName = 'CardDescription';
export const CardContent = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('p-6 pt-0', className)} {...p} />
));
CardContent.displayName = 'CardContent';
export const CardFooter = React.forwardRef(({ className, ...p }, ref) => (
  <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...p} />
));
CardFooter.displayName = 'CardFooter';
`;

const INPUT = `
import * as React from 'react';
import { cn } from '@/lib/utils';
export const Input = React.forwardRef(({ className, type = 'text', ...p }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...p}
  />
));
Input.displayName = 'Input';
`;

const LABEL = `
import * as React from 'react';
import { cn } from '@/lib/utils';
export const Label = React.forwardRef(({ className, ...p }, ref) => (
  <label ref={ref} className={cn('text-sm font-medium leading-none', className)} {...p} />
));
Label.displayName = 'Label';
`;

const BADGE = `
import * as React from 'react';
import { cn } from '@/lib/utils';
const V = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
  outline: 'text-foreground',
};
export function Badge({ className, variant = 'default', ...p }) {
  return <div className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold', V[variant] || V.default, className)} {...p} />;
}
`;

const SEPARATOR = `
import * as React from 'react';
import { cn } from '@/lib/utils';
export function Separator({ className, orientation = 'horizontal', ...p }) {
  return (
    <div
      role="separator"
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...p}
    />
  );
}
`;

/**
 * The host bridge — the app's ONLY door to data + storage. Posts typed requests
 * to the parent and awaits a correlated response. The app holds no secrets; the
 * host resolves them server-side. `__mount` (used by the generated entry) wires
 * the React root, an error boundary, the ready signal, and auto-resize.
 *
 * Mirrors apps/web/lib/app-bridge/protocol.ts — keep the message shapes in sync.
 */
const HOST = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';

const pending = new Map();
let seq = 0;
const rid = () => 'r' + (++seq) + '_' + Math.random().toString(36).slice(2);

function post(partial) {
  return new Promise((resolve, reject) => {
    const id = rid();
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ v: 1, id, ...partial }, '*');
  });
}

const annotateListeners = new Set();

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.v !== 1) return;
  if (m.kind === 'annotate') {
    for (const fn of annotateListeners) { try { fn(m.regions || []); } catch {} }
    paintAnnotations(m.regions || []);
    return;
  }
  if (typeof m.id === 'string' && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p.resolve(m.output);
    else p.reject(new Error(m.error || 'bridge error'));
  }
});

function paintAnnotations(regions) {
  document.querySelectorAll('[data-app-annotated]').forEach((el) => {
    el.removeAttribute('data-app-annotated');
    el.style.outline = '';
    el.style.outlineOffset = '';
  });
  for (const r of regions) {
    const el = document.querySelector('[data-app-region="' + r.id + '"]');
    if (!el) continue;
    el.setAttribute('data-app-annotated', '1');
    el.style.outline = '2px solid var(--ring)';
    el.style.outlineOffset = '2px';
  }
}

export const host = {
  tools: {
    call: (slug, input) => post({ kind: 'tool.call', slug, input: input ?? {} }),
  },
  db: {
    query: (sql, params) => post({ kind: 'db.query', sql, params: params ?? [] }),
    exec: (sql, params) => post({ kind: 'db.exec', sql, params: params ?? [] }),
  },
  ui: {
    resize: (h) => window.parent.postMessage({ v: 1, kind: 'resize', height: h }, '*'),
    notifyError: (msg) => window.parent.postMessage({ v: 1, kind: 'error', message: String(msg) }, '*'),
    onAnnotate: (fn) => { annotateListeners.add(fn); return () => annotateListeners.delete(fn); },
  },
};

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) {
    window.parent.postMessage({ v: 1, kind: 'error', message: String(err && err.message || err), stack: err && err.stack }, '*');
  }
  render() {
    if (this.state.err) {
      return React.createElement(
        'div',
        { className: 'p-4 text-sm text-destructive' },
        'App crashed: ' + String(this.state.err.message || this.state.err),
      );
    }
    return this.props.children;
  }
}

export function __mount(App) {
  const el = document.getElementById('root');
  if (!el) return;
  const root = createRoot(el);
  root.render(React.createElement(ErrorBoundary, null, React.createElement(App)));
  const send = () => host.ui.resize(Math.ceil(document.documentElement.scrollHeight));
  window.parent.postMessage({ v: 1, kind: 'ready' }, '*');
  requestAnimationFrame(send);
  try { new ResizeObserver(send).observe(document.body); } catch {}
}
`;

/** path (as imported in app source) → source string. */
export const KIT: Record<string, string> = {
  '@/lib/utils': UTILS,
  '@/components/ui/button': BUTTON,
  '@/components/ui/card': CARD,
  '@/components/ui/input': INPUT,
  '@/components/ui/label': LABEL,
  '@/components/ui/badge': BADGE,
  '@/components/ui/separator': SEPARATOR,
  '@host': HOST,
};

/** The shadcn-style component import paths an app may use (for the skill doc). */
export const KIT_UI_IMPORTS = Object.keys(KIT).filter((k) => k.startsWith('@/components/ui/'));

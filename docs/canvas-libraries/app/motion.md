# Motion in a mini app

Version: motion 14.6.0, as this brain's app runtime serves it.
Source: the Motion docs for React (motion.dev, its llms.txt index and the
`motion` component, `AnimatePresence` and `MotionConfig` pages) and its
changelog. Written for Mantle, not copied.

## Import

```tsx
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
```

`motion/react`, never `motion` (the plain JavaScript build is for
canvases, and the build refuses it in an app) or `framer-motion` (the old
name). It runs on the app's one shared React. The frame's import map serves
it; it is not bundled into the app.

## In a React component

- `motion.div`, `motion.li`, `motion.svg`, `motion.path` and the rest take
  `initial`, `animate`, `exit` and `transition`. Values are end states:
  `animate={{ opacity: 1, x: 0 }}`. Times are SECONDS.
- `AnimatePresence` around a list or a conditional plays `exit` before a
  child leaves; each child needs a stable `key`.
- `layout` on an element animates its position and size when they change
  (a reordered list, a growing card).
- Variants with `staggerChildren` stagger a list:
  `variants={{ show: { transition: { staggerChildren: 0.05 } } }}` on the
  parent, `variants={{ hidden: {...}, show: {...} }}` on each child.
- `useAnimate()` returns `[scope, animate]` for an imperative sequence in an
  effect; `useReducedMotion()` reads the user's setting.
- Wrap the app in `<MotionConfig reducedMotion="user">` once: it turns
  transforms off for people who asked for less motion.
- Animate `opacity` and transforms (`x`, `y`, `scale`). Colours come from
  theme classes (`bg-primary`), not animated hex values, so a theme switch
  still applies.
- Cleanup is automatic: animations stop when the component unmounts.

## App example

```tsx
import { useState } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { Button } from '@/components/ui/button';

const START = ['Inspect valve V-12', 'Log pump vibration', 'Check drum level'];

export default function App() {
  const [items, setItems] = useState(START);
  const [n, setN] = useState(1);
  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto max-w-md space-y-3 p-6">
        <Button
          onClick={() => {
            setItems((xs) => [`New job ${n}`, ...xs]);
            setN(n + 1);
          }}
        >
          Add a job
        </Button>
        <motion.ul
          className="space-y-2"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.06 } } }}
        >
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.li
                key={item}
                layout
                variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-card-foreground"
              >
                <span>{item}</span>
                <button
                  className="text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setItems((xs) => xs.filter((x) => x !== item))}
                >
                  Done
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
        <motion.div
          className="h-2 rounded-full bg-primary"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: Math.min(1, items.length / 6) }}
          style={{ originX: 0 }}
        />
      </div>
    </MotionConfig>
  );
}
```

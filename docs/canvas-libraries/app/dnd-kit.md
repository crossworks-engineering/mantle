# dnd-kit in a mini app

Version: @dnd-kit/core 6.3.1, as this brain's app runtime serves it, with
@dnd-kit/sortable 10.0.0.
Source: the dnd-kit docs (docs.dndkit.com: DndContext, sensors, the
sortable preset, accessibility). Written for Mantle, not copied.

## Import

```tsx
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
```

Named imports only. Both run on the app's one shared React and share one
copy of the core, so a sortable list and a plain droppable sit in one
`DndContext`. The frame's import map serves them; they are not bundled
into the app. `@dnd-kit/utilities` is not served: write the transform
yourself (below). The newer `@dnd-kit/react` is not served either.

## In a React component

- One `DndContext` around everything that drags. Its `onDragEnd({ active, over })`
  is where you change your state: dnd-kit moves nothing itself.
- Sensors: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))`.
  The distance lets a click on a button inside an item still click. The
  keyboard sensor makes it usable without a mouse (Space to lift, arrows,
  Space to drop); keep it.
- A sorted list: `<SortableContext items={ids} strategy={verticalListSortingStrategy}>`,
  and in each item `useSortable({ id })`. Spread `attributes` and
  `listeners` on the element (or on a handle), set `ref={setNodeRef}`, and
  `style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}`.
- On drop: `setItems((xs) => arrayMove(xs, xs.indexOf(active.id), xs.indexOf(over.id)))`
  when `over` is set and differs from `active`.
- Cards between columns (a board): one `SortableContext` per column and
  `useDroppable({ id: column })` on each column, so an empty column still
  takes a card; in `onDragOver` move the card to the column under it.
- Keep the order in `host.db` after the drop (a position column), not on
  every move.
- `collisionDetection={closestCenter}` suits lists; `closestCorners` suits
  boards.

## App example

```tsx
import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';

function Job({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      className={`flex items-center gap-3 rounded-lg border bg-card px-3 py-3 text-card-foreground ${
        isDragging ? 'relative z-10 shadow-lg ring-2 ring-ring' : ''
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Move ${id}`}
        className="cursor-grab text-muted-foreground"
      >
        <GripVertical className="size-4" />
      </button>
      <span>{id}</span>
    </li>
  );
}

export default function App() {
  const [jobs, setJobs] = useState([
    'Replace gasket on E-101',
    'Calibrate PT-2203',
    'Inspect relief valve PSV-14',
    'Clean strainer on P-305',
    'Check level gauge on D-12',
  ]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    setJobs((xs) => arrayMove(xs, xs.indexOf(String(active.id)), xs.indexOf(String(over.id))));
  }
  return (
    <div className="mx-auto max-w-md space-y-3 p-6 text-foreground">
      <h1 className="text-lg font-semibold">Work order, by priority</h1>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={jobs} strategy={verticalListSortingStrategy}>
          <ol className="space-y-2">
            {jobs.map((j) => (
              <Job key={j} id={j} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <p className="text-sm text-muted-foreground">Drag a handle, or focus it and press Space.</p>
    </div>
  );
}
```

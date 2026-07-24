'use client';

import { CalendarIcon, X } from 'lucide-react';
import { Button } from './button';
import { Calendar } from './calendar';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from '../lib/utils';

const pad = (n: number) => String(n).padStart(2, '0');

/** Friendly trigger label, en-GB-pinned so SSR matches the client (see
 *  lib/format-datetime.ts for the locale-pinning rationale). */
function label(d: Date): string {
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function withTime(date: Date, h: number, m: number): Date {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Date + time picker: the shadcn Calendar in a popover plus a time field — a
 * themed replacement for the browser's native `datetime-local` control. Value
 * is a `Date | null`; picking a date keeps the current time-of-day (defaulting
 * to 09:00 the first time), and the time field combines with the chosen day.
 */
export function DateTimePicker({
  value,
  onChange,
  id,
  placeholder = 'Pick a date & time',
  clearable = false,
}: {
  value: Date | null;
  onChange: (next: Date | null) => void;
  id?: string;
  placeholder?: string;
  clearable?: boolean;
}) {
  const timeStr = value ? `${pad(value.getHours())}:${pad(value.getMinutes())}` : '09:00';

  const pickDate = (day: Date | undefined) => {
    if (!day) return onChange(null);
    const base = value ?? new Date(new Date().setHours(9, 0, 0, 0));
    onChange(withTime(day, base.getHours(), base.getMinutes()));
  };

  const pickTime = (e: React.ChangeEvent<HTMLInputElement>) => {
    const [h, m] = e.target.value.split(':').map(Number);
    onChange(withTime(value ?? new Date(), h || 0, m || 0));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className={cn(
            'w-full justify-start gap-2 font-normal',
            !value && 'text-muted-foreground',
          )}
        >
          <CalendarIcon className="size-4 shrink-0" aria-hidden />
          {value ? label(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={pickDate}
          captionLayout="dropdown"
          autoFocus
        />
        <div className="flex items-center gap-2 border-t border-border p-3">
          <span className="text-sm text-muted-foreground">Time</span>
          <Input type="time" value={timeStr} onChange={pickTime} className="h-9 w-auto" />
          {clearable && value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground"
              onClick={() => onChange(null)}
            >
              <X /> Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

'use client';

import { addDays } from 'date-fns';

import { Calendar } from '@mantle/web-ui/ui/calendar';
import { Card, CardContent } from '@mantle/web-ui/ui/card';

const start = new Date(2025, 5, 5);

export function CardsCalendar() {
  return (
    <Card className="hidden p-0 @2xl:flex">
      <CardContent className="p-0">
        <Calendar
          numberOfMonths={1}
          mode="range"
          defaultMonth={start}
          selected={{
            from: start,
            to: addDays(start, 8),
          }}
        />
      </CardContent>
    </Card>
  );
}

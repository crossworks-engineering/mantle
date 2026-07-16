'use client';

import { TrendingUp } from 'lucide-react';
import { Bar, BarChart, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
const chartData = [
  { tool: 'search', calls: 275, fill: 'var(--color-search)' },
  { tool: 'recall', calls: 200, fill: 'var(--color-recall)' },
  { tool: 'note', calls: 187, fill: 'var(--color-note)' },
  { tool: 'email', calls: 173, fill: 'var(--color-email)' },
  { tool: 'other', calls: 90, fill: 'var(--color-other)' },
];

const chartConfig = {
  calls: {
    label: 'Calls',
  },
  search: {
    label: 'web_search',
    color: 'var(--chart-1)',
  },
  recall: {
    label: 'recall_window',
    color: 'var(--chart-2)',
  },
  note: {
    label: 'note_create',
    color: 'var(--chart-3)',
  },
  email: {
    label: 'email_send',
    color: 'var(--chart-4)',
  },
  other: {
    label: 'other',
    color: 'var(--chart-5)',
  },
} satisfies ChartConfig;

export function ChartBarMixed() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool calls</CardTitle>
        <CardDescription>Across all agents, last 6 months</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig}>
          <BarChart
            accessibilityLayer
            data={chartData}
            layout="vertical"
            margin={{
              left: 0,
            }}
          >
            <YAxis
              dataKey="tool"
              type="category"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
              width={90}
              tickFormatter={(value) => chartConfig[value as keyof typeof chartConfig]?.label}
            />
            <XAxis dataKey="calls" type="number" hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
            <Bar dataKey="calls" layout="vertical" radius={5} />
          </BarChart>
        </ChartContainer>
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 text-sm">
        <div className="flex gap-2 font-medium leading-none">
          Trending up by 5.2% this month <TrendingUp className="h-4 w-4" />
        </div>
        <div className="leading-none text-muted-foreground">
          Showing total tool calls for the last 6 months
        </div>
      </CardFooter>
    </Card>
  );
}

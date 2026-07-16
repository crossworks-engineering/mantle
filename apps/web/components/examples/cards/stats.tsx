'use client';

import { Area, AreaChart, Line, LineChart } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartConfig, ChartContainer } from '@/components/ui/chart';

const data = [
  { tokens: 10400, traces: 40 },
  { tokens: 14405, traces: 90 },
  { tokens: 9400, traces: 200 },
  { tokens: 8200, traces: 278 },
  { tokens: 7000, traces: 89 },
  { tokens: 9600, traces: 239 },
  { tokens: 11244, traces: 78 },
  { tokens: 26475, traces: 89 },
];

const chartConfig = {
  tokens: {
    label: 'Tokens',
    color: 'var(--primary)',
  },
  traces: {
    label: 'Traces',
    color: 'var(--primary)',
  },
} satisfies ChartConfig;

export function CardsStats() {
  return (
    <div className="grid gap-4 @xl:grid-cols-2 @5xl:grid-cols-1 @7xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Tokens this month</CardDescription>
          <CardTitle className="text-3xl">1.28M</CardTitle>
          <CardDescription>+20.1% from last month</CardDescription>
        </CardHeader>
        <CardContent className="pb-0">
          <ChartContainer config={chartConfig} className="h-[90px] w-full">
            <LineChart
              data={data}
              margin={{
                top: 5,
                right: 10,
                left: 10,
                bottom: 0,
              }}
            >
              <Line
                type="monotone"
                strokeWidth={2}
                dataKey="tokens"
                stroke="var(--color-tokens)"
                activeDot={{
                  r: 6,
                }}
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <Card className="relative flex flex-col overflow-hidden pb-0 @5xl:hidden @7xl:flex">
        <CardHeader>
          <CardDescription>Traces run</CardDescription>
          <CardTitle className="text-3xl">+2,350</CardTitle>
          <CardDescription>+180.1% from last month</CardDescription>
        </CardHeader>
        <CardContent className="relative mt-auto flex-1 p-0">
          <ChartContainer config={chartConfig} className="relative size-full h-[90px]">
            <AreaChart
              data={data}
              margin={{
                left: 0,
                right: 0,
              }}
              className="size-fit"
            >
              <Area
                dataKey="traces"
                fill="var(--color-traces)"
                fillOpacity={0.05}
                stroke="var(--color-traces)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}

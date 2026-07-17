import Link from 'next/link';
import { TrendingDownIcon, TrendingUpIcon, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type Kpi = {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  trend?: { dir: 'up' | 'down' | 'flat'; text: string; good?: boolean };
  href?: string;
  /** Visually flag an actionable card (e.g. pending review > 0). */
  accent?: boolean;
};

/** Headline KPI grid, adapted from the appearance dashboard's SectionCards. */
export function KpiCards({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((k) => {
        const body = (
          <Card
            className={cn(
              'h-full bg-gradient-to-t from-primary/5 to-card transition-colors',
              k.href && 'hover:border-primary/40',
              k.accent && 'border-primary/40 from-primary/15',
            )}
          >
            <CardHeader className="relative">
              <CardDescription className="flex items-center gap-1.5">
                {k.icon && <k.icon className="size-3.5" aria-hidden />}
                {k.label}
              </CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums">{k.value}</CardTitle>
              {k.trend && (
                <div className="absolute right-4 top-4">
                  <Badge
                    variant="outline"
                    className={cn(
                      'flex gap-1 rounded-lg text-xs',
                      k.trend.good === true && 'text-emerald-600 dark:text-emerald-400',
                      k.trend.good === false && 'text-destructive',
                    )}
                  >
                    {k.trend.dir === 'down' ? (
                      <TrendingDownIcon className="size-3" />
                    ) : k.trend.dir === 'up' ? (
                      <TrendingUpIcon className="size-3" />
                    ) : null}
                    {k.trend.text}
                  </Badge>
                </div>
              )}
            </CardHeader>
            {k.hint && <CardFooter className="text-sm text-muted-foreground">{k.hint}</CardFooter>}
          </Card>
        );
        return k.href ? (
          <Link key={k.label} href={k.href} className="block">
            {body}
          </Link>
        ) : (
          <div key={k.label}>{body}</div>
        );
      })}
    </div>
  );
}

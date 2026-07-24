'use client';

import { Activity, Circle, Settings2 } from 'lucide-react';

import { Button } from '@mantle/web-ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';

export function GithubCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="font-mono">web_search</CardTitle>
            <CardDescription>
              The Researcher&apos;s tool — Perplexity Sonar via OpenRouter. Returns cited synthesis
              the assistant can save to the brain.
            </CardDescription>
          </div>
          <div className="bg-secondary text-secondary-foreground flex min-w-24 shrink-0 items-center space-x-1 rounded-md">
            <Button variant="secondary" className="flex items-center gap-2 px-3 shadow-none">
              <Settings2 />
              Configure
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-muted-foreground flex space-x-4 text-sm">
          <div className="flex items-center gap-1">
            <Circle className="size-3 fill-chart-2 text-chart-2" />
            Agent tool
          </div>
          <div className="flex items-center gap-1">
            <Activity className="size-3" />
            1.2k calls
          </div>
          <div>Updated today</div>
        </div>
      </CardContent>
    </Card>
  );
}

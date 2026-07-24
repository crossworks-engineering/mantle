'use client';

import { Button } from '@mantle/web-ui/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@mantle/web-ui/ui/card';
import { Label } from '@mantle/web-ui/ui/label';
import { Switch } from '@mantle/web-ui/ui/switch';

export function CardsCookieSettings() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ingest settings</CardTitle>
        <CardDescription>How new content enters your brain.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="summarize" className="flex flex-col items-start">
            <span>Eager summarization</span>
            <span className="text-muted-foreground leading-snug font-normal">
              Summarize every node on ingest so recall stays citable and deterministic.
            </span>
          </Label>
          <Switch id="summarize" defaultChecked aria-label="Eager summarization" />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="embeddings" className="flex flex-col items-start">
            <span>Generate embeddings</span>
            <span className="text-muted-foreground leading-snug font-normal">
              Embed each node for semantic search and Remy's window recall.
            </span>
          </Label>
          <Switch id="embeddings" defaultChecked aria-label="Generate embeddings" />
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="outline" className="w-full">
          Save settings
        </Button>
      </CardFooter>
    </Card>
  );
}

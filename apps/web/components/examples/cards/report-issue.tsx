'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export function CardsReportIssue() {
  const id = React.useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask the Researcher</CardTitle>
        <CardDescription>Saskia hands deep questions to the Researcher.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-4 @2xl:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Label htmlFor={`area-${id}`}>Source</Label>
            <Select defaultValue="web">
              <SelectTrigger id={`area-${id}`} aria-label="Source" className="w-full">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="memory">Memory</SelectItem>
                <SelectItem value="both">Web + Memory</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-3">
            <Label htmlFor={`depth-${id}`}>Depth</Label>
            <Select defaultValue="standard">
              <SelectTrigger
                id={`depth-${id}`}
                className="w-full [&_span]:!block [&_span]:truncate"
                aria-label="Depth"
              >
                <SelectValue placeholder="Select depth" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">Quick (1 hop)</SelectItem>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="deep">Deep (multi-hop)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Label htmlFor={`subject-${id}`}>Question</Label>
          <Input id={`subject-${id}`} placeholder="What changed in…" />
        </div>
        <div className="flex flex-col gap-3">
          <Label htmlFor={`description-${id}`}>Context</Label>
          <Textarea
            id={`description-${id}`}
            placeholder="Anything from your brain that should guide the search."
            className="min-h-28"
          />
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
        <Button size="sm">Ask</Button>
      </CardFooter>
    </Card>
  );
}

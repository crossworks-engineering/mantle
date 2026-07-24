'use client';

import { Bot, Sparkles } from 'lucide-react';

import { Button } from '@mantle/web-ui/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@mantle/web-ui/ui/card';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';

export function CardsCreateAccount() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Connect a provider</CardTitle>
        <CardDescription>Add a model provider to power your agents</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-6">
          <Button variant="outline">
            <Sparkles />
            Anthropic
          </Button>
          <Button variant="outline">
            <Bot />
            OpenRouter
          </Button>
        </div>
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card text-muted-foreground px-2">Or enter a key</span>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Label htmlFor="provider-base-url">Base URL</Label>
          <Input id="provider-base-url" placeholder="https://api.anthropic.com" />
        </div>
        <div className="flex flex-col gap-3">
          <Label htmlFor="provider-api-key">API key</Label>
          <Input id="provider-api-key" type="password" placeholder="sk-ant-…" />
        </div>
      </CardContent>
      <CardFooter>
        <Button
          variant="default"
          className="group bg-primary text-primary-foreground ring-primary before:from-primary-foreground/20 after:from-primary-foreground/10 relative isolate inline-flex w-full items-center justify-center overflow-hidden rounded-md px-3 text-left text-sm font-medium ring-1 transition duration-300 ease-[cubic-bezier(0.4,0.36,0,1)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-md before:bg-gradient-to-b before:opacity-80 before:transition-opacity before:duration-300 before:ease-[cubic-bezier(0.4,0.36,0,1)] after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:rounded-md after:bg-gradient-to-b after:to-transparent after:mix-blend-overlay"
        >
          Connect provider
        </Button>
      </CardFooter>
    </Card>
  );
}

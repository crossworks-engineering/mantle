'use client';

import { ChevronDown } from 'lucide-react';

import { Avatar, AvatarFallback } from '@mantle/web-ui/ui/avatar';
import { Button } from '@mantle/web-ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@mantle/web-ui/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@mantle/web-ui/ui/popover';

const agents = [
  {
    name: 'Saskia',
    role: 'Assistant',
    initials: 'Sa',
    model: 'Claude Sonnet 4.6',
  },
  {
    name: 'Remy',
    role: 'Memory recall',
    initials: 'Re',
    model: 'Claude Haiku 4.5',
  },
  {
    name: 'Researcher',
    role: 'Web search',
    initials: 'Rs',
    model: 'Perplexity Sonar',
  },
];

const models = [
  {
    name: 'Claude Opus 4.7',
    description: 'Deepest reasoning, highest cost.',
  },
  {
    name: 'Claude Sonnet 4.6',
    description: 'Balanced default for the assistant.',
  },
  {
    name: 'Claude Haiku 4.5',
    description: 'Fast and cheap for sub-agents.',
  },
  {
    name: 'Local (Llama)',
    description: 'Runs on-box for ingest extraction.',
  },
];

export function CardsTeamMembers() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardDescription>The agents working inside your brain.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {agents.map((agent) => (
          <div key={agent.name} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Avatar className="border">
                <AvatarFallback className="text-xs">{agent.initials}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col gap-0.5">
                <p className="text-sm leading-none font-medium">{agent.name}</p>
                <p className="text-muted-foreground text-xs">{agent.role}</p>
              </div>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto shadow-none">
                  {agent.model} <ChevronDown />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0" align="end">
                <Command>
                  <CommandInput placeholder="Select model..." />
                  <CommandList>
                    <CommandEmpty>No models found.</CommandEmpty>
                    <CommandGroup>
                      {models.map((model) => (
                        <CommandItem key={model.name}>
                          <div className="flex flex-col">
                            <p className="text-sm font-medium">{model.name}</p>
                            <p className="text-muted-foreground">{model.description}</p>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

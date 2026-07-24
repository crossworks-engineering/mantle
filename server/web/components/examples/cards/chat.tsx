'use client';

import * as React from 'react';

import { Avatar, AvatarFallback } from '@mantle/web-ui/ui/avatar';
import { Button } from '@mantle/web-ui/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@mantle/web-ui/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@mantle/web-ui/ui/command';
import { Input } from '@mantle/web-ui/ui/input';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@mantle/web-ui/ui/revola';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@mantle/web-ui/ui/tooltip';
import { cn } from '@mantle/web-ui/lib/utils';
import { ArrowUpIcon, CheckIcon, PlusIcon } from 'lucide-react';

const agents = [
  { name: 'Remy', role: 'Memory recall', initials: 'Re' },
  { name: 'Researcher', role: 'Web search', initials: 'Rs' },
  { name: 'Ingest', role: 'Local extractor', initials: 'In' },
  { name: 'Heartbeat', role: 'Scheduled runs', initials: 'Hb' },
] as const;

type Agent = (typeof agents)[number];

export function CardsChat() {
  const [open, setOpen] = React.useState(false);
  const [selectedAgents, setSelectedAgents] = React.useState<Agent[]>([]);

  const [messages, setMessages] = React.useState([
    {
      role: 'agent',
      content: "Hi, I'm Saskia. Ask me anything about your brain.",
    },
    {
      role: 'user',
      content: 'What did I decide about the memory architecture?',
    },
    {
      role: 'agent',
      content: 'On 2026-05-17 you chose eager summarization on ingest — citable over write-cost.',
    },
    {
      role: 'user',
      content: 'Pull the full thread.',
    },
  ]);
  const [input, setInput] = React.useState('');
  const inputLength = input.trim().length;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center">
          <div className="flex items-center gap-4">
            <Avatar className="border">
              <AvatarFallback>Sa</AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-0.5">
              <p className="text-sm leading-none font-medium">Saskia</p>
              <p className="text-muted-foreground text-xs">Assistant · Claude Sonnet 4.6</p>
            </div>
          </div>
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="secondary"
                  className="ml-auto size-8 rounded-full"
                  onClick={() => setOpen(true)}
                >
                  <PlusIcon />
                  <span className="sr-only">Invoke an agent</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={10}>Invoke an agent</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {messages.map((message, index) => (
              <div
                key={index}
                className={cn(
                  'flex w-max max-w-[75%] flex-col gap-2 rounded-lg px-3 py-2 text-sm',
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground ml-auto'
                    : 'bg-muted',
                )}
              >
                {message.content}
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (inputLength === 0) return;
              setMessages([
                ...messages,
                {
                  role: 'user',
                  content: input,
                },
              ]);
              setInput('');
            }}
            className="relative w-full"
          >
            <Input
              id="message"
              placeholder="Ask your brain..."
              className="flex-1 pr-10"
              autoComplete="off"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <Button
              type="submit"
              size="icon"
              className="absolute top-1/2 right-2 size-6 -translate-y-1/2 rounded-full"
              disabled={inputLength === 0}
            >
              <ArrowUpIcon />
              <span className="sr-only">Send</span>
            </Button>
          </form>
        </CardFooter>
      </Card>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent className="flex max-h-[85%] flex-col gap-0">
          <ResponsiveDialogHeader className="p-4 pt-0 sm:pt-5">
            <ResponsiveDialogTitle>Invoke an agent</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Saskia can hand work to a sub-agent. Pick who joins this thread.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <Command className="overflow-hidden rounded-t-none border-t bg-transparent">
            <CommandInput placeholder="Search agents..." />
            <CommandList>
              <CommandEmpty>No agents found.</CommandEmpty>
              <CommandGroup>
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.name}
                    data-active={selectedAgents.includes(agent)}
                    className="gap-2 data-[active=true]:opacity-50"
                    onSelect={() => {
                      if (selectedAgents.includes(agent)) {
                        return setSelectedAgents(
                          selectedAgents.filter((selected) => selected !== agent),
                        );
                      }
                      return setSelectedAgents(
                        [...agents].filter((a) => [...selectedAgents, agent].includes(a)),
                      );
                    }}
                  >
                    <Avatar className="size-7.5 border">
                      <AvatarFallback className="text-xs">{agent.initials}</AvatarFallback>
                    </Avatar>
                    <div className="ml-2">
                      <p className="text-sm leading-none font-medium">{agent.name}</p>
                      <p className="text-muted-foreground text-sm">{agent.role}</p>
                    </div>
                    {selectedAgents.includes(agent) ? (
                      <CheckIcon className="text-primary ml-auto flex size-4" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>

          <ResponsiveDialogFooter className="items-center border-t p-4 sm:justify-between">
            {selectedAgents.length > 0 ? (
              <div className="flex -space-x-2 overflow-hidden">
                {selectedAgents.map((agent) => (
                  <Avatar key={agent.name} className="inline-block size-7.5 border">
                    <AvatarFallback className="text-xs">{agent.initials}</AvatarFallback>
                  </Avatar>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Select agents to add to this thread.</p>
            )}
            <Button
              onClick={() => {
                setOpen(false);
              }}
              disabled={selectedAgents.length < 1}
            >
              Invoke
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

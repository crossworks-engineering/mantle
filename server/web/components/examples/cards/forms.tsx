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
import { Checkbox } from '@mantle/web-ui/ui/checkbox';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@mantle/web-ui/ui/radio-group';
import { Textarea } from '@mantle/web-ui/ui/textarea';

const tiers = [
  {
    id: 'cloud',
    name: 'Cloud model',
    description: 'Anthropic / OpenRouter. Best reasoning.',
  },
  {
    id: 'local',
    name: 'Local model',
    description: 'Runs on-box. Private, no token cost.',
  },
] as const;

export function CardsForms() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">New agent</CardTitle>
        <CardDescription className="text-balance">
          Agents read from and write to your brain. Give one a name, a model, and instructions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 @3xl:flex-row">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" placeholder="Researcher" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="agent-slug">Slug</Label>
              <Input id="agent-slug" placeholder="researcher" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-model">Model &amp; sampling</Label>
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-[1fr_80px_60px]">
              <Input
                id="agent-model"
                placeholder="claude-sonnet-4-6"
                className="col-span-2 @3xl:col-span-1"
              />
              <Input id="agent-temp" placeholder="Temp" defaultValue="0.7" />
              <Input id="agent-topp" placeholder="Top-p" defaultValue="1" />
            </div>
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Runtime</legend>
            <p className="text-muted-foreground text-sm">
              Pick where this agent runs its inference.
            </p>
            <RadioGroup defaultValue="cloud" className="grid gap-3 @3xl:grid-cols-2">
              {tiers.map((tier) => (
                <Label
                  className="has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-input/20 flex items-start gap-3 rounded-lg border p-3"
                  key={tier.id}
                >
                  <RadioGroupItem
                    value={tier.id}
                    id={tier.name}
                    className="data-[state=checked]:border-primary"
                  />
                  <div className="grid gap-1 font-normal">
                    <div className="font-medium">{tier.name}</div>
                    <div className="text-muted-foreground text-xs leading-snug text-balance">
                      {tier.description}
                    </div>
                  </div>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-prompt">System prompt</Label>
            <Textarea
              id="agent-prompt"
              placeholder="You are the Researcher. Search the web and return cited synthesis…"
            />
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Checkbox id="agent-write" />
              <Label htmlFor="agent-write" className="font-normal">
                Can write to the brain
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="agent-heartbeat" defaultChecked />
              <Label htmlFor="agent-heartbeat" className="font-normal">
                Run on heartbeats
              </Label>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" size="sm">
          Cancel
        </Button>
        <Button size="sm">Create agent</Button>
      </CardFooter>
    </Card>
  );
}

'use client';

import { ArrowRight, CircleCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

interface MemoryTier {
  id: string;
  name: string;
  description: string;
  retention: string;
  capacity: string;
  inherits?: string;
  features: string[];
  button: string;
}

interface MemoryTiersProps {
  heading?: string;
  description?: string;
  tiers?: MemoryTier[];
}

const MemoryTiers = ({
  heading = 'Tiered memory',
  description = 'Mantle remembers across three tiers — from the live conversation to a permanent, citable knowledge graph.',
  tiers = [
    {
      id: 'short',
      name: 'Short-term',
      description: 'The live conversation',
      retention: 'Minutes',
      capacity: '~50 turns',
      features: [
        'Raw turns kept verbatim',
        'Cleared when the session ends',
        'Feeds the working tier',
      ],
      button: 'Open session',
    },
    {
      id: 'long',
      name: 'Long-term',
      description: 'Everything, forever',
      retention: 'Permanent',
      capacity: 'Unbounded',
      inherits: 'Short-term',
      features: [
        'Eager summaries on ingest',
        'Embeddings for semantic recall',
        'Durable, cited knowledge graph',
      ],
      button: 'Browse graph',
    },
  ],
}: MemoryTiersProps) => {
  const [showCapacity, setShowCapacity] = useState(false);
  return (
    <section className="@container py-16">
      <div className="container mx-auto">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-8 text-center">
          <div className="flex size-full flex-col items-center gap-4">
            <h2 className="text-foreground text-3xl leading-tight font-bold tracking-tight text-pretty @3xl:text-5xl">
              {heading}
            </h2>
            <p className="text-muted-foreground max-w-2xl text-balance @3xl:text-xl">
              {description}
            </p>
            <div className="text-foreground flex items-center gap-3 text-lg">
              Retention
              <Switch
                checked={showCapacity}
                onCheckedChange={() => setShowCapacity(!showCapacity)}
                aria-label="Toggle between retention and capacity"
              />
              Capacity
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-6 @3xl:flex-row">
            {tiers.map((tier) => (
              <Card key={tier.id} className="flex w-80 flex-col justify-between text-left">
                <CardHeader>
                  <CardTitle>
                    <p>{tier.name}</p>
                  </CardTitle>
                  <p className="text-muted-foreground text-sm">{tier.description}</p>
                  <span className="text-4xl font-bold">
                    {showCapacity ? tier.capacity : tier.retention}
                  </span>
                  <p className="text-muted-foreground">
                    {showCapacity
                      ? `Retained for ${tier.retention.toLowerCase()}`
                      : `Holds ${tier.capacity}`}
                  </p>
                </CardHeader>
                <CardContent>
                  <Separator className="mb-6" />
                  {tier.inherits && (
                    <p className="mb-3 font-semibold">Everything in {tier.inherits}, and:</p>
                  )}
                  <ul className="space-y-4">
                    {tier.features.map((feature, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <CircleCheck className="size-4 shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter className="mt-auto">
                  <Button className="w-full">
                    {tier.button}
                    <ArrowRight />
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default MemoryTiers;

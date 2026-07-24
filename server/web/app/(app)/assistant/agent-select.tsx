'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { useAssistantDock } from '@/components/assistant/assistant-dock';
import type { AssistantAgentOption } from '@/lib/assistant';

/** Agent picker for the assistant panel. Switching updates the selected agent
 *  in the app-wide dock (which re-keys the thread query in place AND persists
 *  the choice to the `mantle_assistant_agent` cookie) — no navigation. */
export function AgentSelect({
  agents,
  selected,
}: {
  agents: AssistantAgentOption[];
  selected: string;
}) {
  const { setActiveAgentSlug } = useAssistantDock();
  function pick(slug: string) {
    setActiveAgentSlug(slug);
  }
  return (
    <Select value={selected} onValueChange={pick}>
      <SelectTrigger className="w-60" aria-label="Choose agent">
        <SelectValue placeholder="Select agent" />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a.slug} value={a.slug}>
            <span className="font-medium">{a.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {a.role} · {a.model.split('/').pop()}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

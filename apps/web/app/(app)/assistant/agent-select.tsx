'use client';

import { useRouter } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AssistantAgentOption } from '@/lib/assistant';

const COOKIE = 'mantle_assistant_agent';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Agent picker for /assistant. Switching navigates to ?agent=<slug> AND
 *  writes a cookie so the choice survives navigation away and back without
 *  a URL param. Server reads the cookie in page.tsx as the SSR default.
 *  Pattern mirrors mantle_spend_range in usage-card-pills. */
export function AgentSelect({
  agents,
  selected,
}: {
  agents: AssistantAgentOption[];
  selected: string;
}) {
  const router = useRouter();
  function pick(slug: string) {
    document.cookie = `${COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    router.push(`/assistant?agent=${encodeURIComponent(slug)}`);
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

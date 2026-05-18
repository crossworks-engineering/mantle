import { requireOwner } from '@/lib/auth';
import { recentAssistantMessages, resolveAssistantAgent } from '@/lib/assistant';
import { AssistantClient } from './assistant-client';

export default async function AssistantPage() {
  const user = await requireOwner();
  const [messages, agent] = await Promise.all([
    recentAssistantMessages(user.id, 200),
    resolveAssistantAgent(user.id),
  ]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-3">
        <h1 className="text-lg font-semibold">Assistant</h1>
        <p className="text-xs text-muted-foreground">
          One ongoing conversation. Same persona, facts, and content_index as your
          Telegram responder — different transport.
          {agent ? (
            <>
              {' '}
              · agent <code className="font-mono">{agent.slug}</code> ·{' '}
              <code className="font-mono">{agent.model}</code>
            </>
          ) : (
            <span className="ml-1 text-destructive">
              No assistant or responder agent enabled. Configure one at{' '}
              <a href="/settings/agents" className="underline">
                /settings/agents
              </a>
              .
            </span>
          )}
        </p>
      </header>

      <AssistantClient initialMessages={messages} agentReady={!!agent} />
    </div>
  );
}

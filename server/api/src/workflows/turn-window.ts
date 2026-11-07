/**
 * The window a turn's ui tools act in (docs/agent-ui.md) rides only on the
 * run that minted the turn: its workflow id is the turn's stream id (POST
 * /api/assistant/turn makes them one). A Runners restart or fork runs the
 * same input under a new workflow id, long after the person's window moved
 * on: it runs with no window, so it is offered no ui tools. A recovery or a
 * resume keeps the turn's own workflow id, and its window.
 */
export function withRunWindow<T extends { windowId?: string; streamId?: string }>(
  options: T,
  workflowID: string | undefined,
): T {
  if (options.windowId === undefined) return options;
  if (workflowID !== undefined && options.streamId === workflowID) return options;
  const { windowId: _dropped, ...rest } = options;
  return rest as T;
}

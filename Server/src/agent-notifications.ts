export async function notifyAgentCommandAvailable(
  env: Env,
  agentId: string
): Promise<void> {
  if (!env.AGENT_LOGS || !agentId) return;
  try {
    const response = await env.AGENT_LOGS.getByName("global").fetch(
      new Request("https://agent.internal/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "command-available", agentId })
      })
    );
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "agent_command_notification_failed",
        agentId,
        status: response.status
      }));
    }
  } catch (error) {
    // The command is already durable in D1. Agents also drain the queue on
    // every WebSocket reconnect, so a failed wake-up cannot lose the command.
    console.error(JSON.stringify({
      event: "agent_command_notification_failed",
      agentId,
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}

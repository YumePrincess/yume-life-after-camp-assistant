export class AgentApi {
  constructor(config) {
    this.baseUrl = config.server.baseUrl.replace(/\/+$/, "");
    this.token = config.server.agentToken;
    this.agentId = config.server.agentId;
  }

  async request(path, body, signal) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${path}: ${payload.error || `HTTP ${response.status}`}`);
    }
    return payload;
  }

  heartbeat(input, signal) {
    return this.request(
      "/api/agent/heartbeat",
      { agentId: this.agentId, ...input },
      signal
    );
  }

  nextCommand(busy, signal) {
    return this.request(
      "/api/agent/next-command",
      { agentId: this.agentId, busy },
      signal
    );
  }

  bootstrap(runId, signal) {
    return this.request(
      "/api/agent/bootstrap",
      { agentId: this.agentId, runId },
      signal
    );
  }

  updateRun(runId, update, signal) {
    return this.request("/api/agent/run-update", { runId, ...update }, signal);
  }

  snapshot(runId, type, payload, capturedAt, signal) {
    return this.request(
      "/api/agent/snapshot",
      { runId, type, payload, capturedAt },
      signal
    );
  }

  completeCommand(command, state, message, signal) {
    return this.request(
      "/api/agent/complete-command",
      {
        commandId: command.id,
        leaseToken: command.leaseToken,
        state,
        message
      },
      signal
    );
  }
}

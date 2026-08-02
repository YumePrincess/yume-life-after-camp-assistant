import { delay } from "./process.mjs";

export class AgentApi {
  constructor(config) {
    this.baseUrl = config.server.baseUrl.replace(/\/+$/, "");
    this.token = config.server.agentToken;
    this.agentId = config.server.agentId;
    this.displayName = config.server.agentName || this.agentId;
  }

  async request(path, body, signal, { maximumAttempts = 1 } = {}) {
    let response;
    let lastNetworkError;
    const attempts = Math.max(1, Math.min(4, Number(maximumAttempts) || 1));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal
        });
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastNetworkError = error;
        if (attempt >= attempts || !isTransientNetworkError(error)) break;
        await delay(attempt * 500, signal);
      }
    }
    if (!response) {
      throw new Error(formatNetworkError(path, lastNetworkError, attempts));
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = payload.code ? ` [${payload.code}]` : "";
      throw new Error(
        `${path}: ${payload.error || `HTTP ${response.status}`}${code}`
      );
    }
    return payload;
  }

  heartbeat(input, signal) {
    return this.request(
      "/api/agent/heartbeat",
      { agentId: this.agentId, displayName: this.displayName, ...input },
      signal,
      { maximumAttempts: 3 }
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

function isTransientNetworkError(error) {
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(error?.cause?.code);
}

function formatNetworkError(path, error, attempts) {
  const cause = error?.cause;
  const code = cause?.code;
  const endpoint = cause?.hostname
    ? `${cause.hostname}${cause.port ? `:${cause.port}` : ""}`
    : null;
  const retry = attempts > 1 ? `，已自动尝试 ${attempts} 次` : "";
  if (code === "ECONNRESET" && Number(cause?.port) === 443) {
    return `${path}: HTTPS 连接被远端临时重置${retry}（ECONNRESET，端口 443；这不是 HTTP 443 状态码）`;
  }
  const details = [code, endpoint].filter(Boolean).join("，");
  return `${path}: ${error?.message || "Network request failed"}${retry}${
    details ? `（${details}）` : ""
  }`;
}

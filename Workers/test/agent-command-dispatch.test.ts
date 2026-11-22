import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  claimNextCommand: vi.fn(),
  completeCommand: vi.fn(),
  expireUnclaimedRuns: vi.fn(),
  finalizeAgentCancellations: vi.fn(),
  finalizeExpiredCancellations: vi.fn(),
  getConfigBundle: vi.fn(),
  reconcileStaleCommands: vi.fn(),
  updateRun: vi.fn()
}));

vi.mock("../src/db", () => dbMocks);

vi.mock("../src/plugin-system", () => ({
  builtPluginForTask: () => null,
  effectiveWorkerPlugins: vi.fn(async () => [])
}));

import { claimAgentCommand } from "../src/agent-command-dispatch";

describe("claimAgentCommand cancellation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getConfigBundle.mockResolvedValue({
      campConfig: { agentId: "agent-1" },
      automationConfig: { agent: { claimTimeoutMinutes: 5 } }
    });
    dbMocks.reconcileStaleCommands.mockResolvedValue(undefined);
    dbMocks.expireUnclaimedRuns.mockResolvedValue([]);
    dbMocks.claimNextCommand.mockResolvedValue({
      id: "interrupt-1",
      run_id: "run-1",
      type: "interrupt_task",
      payload_json: JSON.stringify({ runId: "run-1" }),
      lease_token: "lease-1",
      attempt_count: 1
    });
  });

  it("leaves a busy Agent's cancelling run active while claiming its interrupt", async () => {
    const result = await claimAgentCommand({} as Env, {
      agentId: "agent-1",
      busy: true
    });

    expect(result.command).toMatchObject({
      id: "interrupt-1",
      runId: "run-1",
      type: "interrupt_task"
    });
    expect(dbMocks.claimNextCommand).toHaveBeenCalledWith(expect.anything(), {
      agentId: "agent-1",
      busy: true
    });
    expect(dbMocks.finalizeAgentCancellations).not.toHaveBeenCalled();
    expect(dbMocks.finalizeExpiredCancellations).not.toHaveBeenCalled();
  });
});

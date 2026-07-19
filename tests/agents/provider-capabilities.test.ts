import { describe, expect, test } from "bun:test";
import type { AgentStartRequest } from "@local-pair-review/shared";
import {
  UnsupportedProviderCapabilityError,
  type AgentControlStartRequest,
} from "../../apps/server/src/drivers/agent-control";
import { ClaudeCliDriver } from "../../apps/server/src/drivers/claude-cli.driver";
import { CodexCliDriver } from "../../apps/server/src/drivers/codex-cli.driver";
import { createProviderRegistry } from "../../apps/server/src/drivers/provider-registry";

const unavailable = {
  installed: false,
  executablePath: null,
  version: null,
  authentication: "unknown" as const,
  model: null,
  modelSource: null,
  reasoningEffort: null,
  message: "not checked",
};

function request(overrides: Partial<AgentControlStartRequest> = {}): AgentControlStartRequest {
  return {
    runId: "run-capability-test",
    taskId: "task-capability-test",
    projectId: "project-capability-test",
    workingDirectory: "/tmp/provider-capability-test",
    prompt: "Do not start a real process.",
    runType: "developer_initial",
    ...overrides,
  } satisfies AgentStartRequest;
}

describe("provider capability declarations", () => {
  const codex = new CodexCliDriver({ executablePath: "/opt/codex" });
  const claude = new ClaudeCliDriver({ executablePath: "/opt/claude" });

  test("declares every Codex interaction capability independently", () => {
    expect(codex.capabilities).toEqual({
      developerInitialImage: true,
      developerResumeImage: true,
      reviewerInitialImage: true,
      reviewerResumeImage: true,
      liveMessages: false,
      interrupt: true,
      approvals: false,
    });
  });

  test("does not infer Claude image or streaming controls from interactive CLI behavior", () => {
    expect(claude.capabilities).toEqual({
      developerInitialImage: false,
      developerResumeImage: false,
      reviewerInitialImage: false,
      reviewerResumeImage: false,
      liveMessages: false,
      interrupt: true,
      approvals: false,
    });
  });

  test("includes conservative capabilities in provider descriptors", () => {
    const descriptors = createProviderRegistry({ codex, claude }).descriptors({
      codex: unavailable,
      claude: unavailable,
    });

    expect(descriptors.map(({ id, capabilities }) => ({ id, capabilities }))).toEqual([
      { id: "codex", capabilities: codex.capabilities },
      { id: "claude", capabilities: claude.capabilities },
    ]);
  });

  test("returns typed user-displayable failures for unsupported live messages and approvals", async () => {
    await expect(claude.sendLiveMessage("run-1", "Follow up"))
      .rejects.toMatchObject({
        name: "UnsupportedProviderCapabilityError",
        provider: "claude",
        capability: "liveMessages",
      });
    await expect(codex.resolveApproval("run-1", "approval-1", "allow_once"))
      .rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  test("maps role and actual resume phase to image capabilities independently", () => {
    expect(codex.imageCapability(request())).toBe("developerInitialImage");
    expect(codex.imageCapability(request({ sessionId: "developer-session" }))).toBe("developerResumeImage");
    expect(codex.imageCapability(request({ runType: "reviewer" }))).toBe("reviewerInitialImage");
    expect(codex.imageCapability(request({ runType: "reviewer_followup", sessionId: "review-session" })))
      .toBe("reviewerResumeImage");
  });
});

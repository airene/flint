import { describe, expect, test } from "bun:test";
import {
  buildClaudeArgs,
  buildCodexArgs,
  reviewJsonSchema,
} from "../../apps/server/src/drivers/cli-arguments";
import { createCliEnvironment } from "../../apps/server/src/utils/process-environment";
import { redactSensitive } from "../../apps/server/src/utils/redact";

describe("CLI child environment", () => {
  test("removes every explicit API credential from the child copy only", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "openai-secret",
      CODEX_API_KEY: "codex-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
    };

    const child = createCliEnvironment(parent);

    expect(child).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
    });
    expect(parent.OPENAI_API_KEY).toBe("openai-secret");
    expect(parent.CODEX_API_KEY).toBe("codex-secret");
    expect(parent.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(parent.ANTHROPIC_AUTH_TOKEN).toBe("anthropic-token");
  });
});

describe("CLI argument arrays", () => {
  test("builds Codex developer initial and exact-session resume invocations", () => {
    expect(buildCodexArgs("/opt/codex", "developer_initial")).toEqual([
      "/opt/codex",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-",
    ]);

    expect(buildCodexArgs("/opt/codex", "developer_feedback", "thread-exact-123")).toEqual([
      "/opt/codex",
      "exec",
      "resume",
      "thread-exact-123",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-",
    ]);
  });

  test("places controlled absolute image paths correctly for all Codex role and phase combinations", () => {
    expect(buildCodexArgs(
      "/opt/codex",
      "developer_initial",
      undefined,
      undefined,
      ["/tmp/input-one.png", "/tmp/input-two.jpg"],
    )).toEqual([
      "/opt/codex",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--image",
      "/tmp/input-one.png",
      "--image",
      "/tmp/input-two.jpg",
      "-",
    ]);

    expect(buildCodexArgs(
      "/opt/codex",
      "developer_followup",
      "developer-session",
      undefined,
      ["/tmp/developer-followup.png"],
    )).toEqual([
      "/opt/codex",
      "exec",
      "resume",
      "developer-session",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "--image",
      "/tmp/developer-followup.png",
      "-",
    ]);

    expect(buildCodexArgs(
      "/opt/codex",
      "reviewer",
      undefined,
      "/tmp/review-schema.json",
      ["/tmp/review-initial.png"],
    )).toEqual([
      "/opt/codex",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/tmp/review-schema.json",
      "--image",
      "/tmp/review-initial.png",
      "-",
    ]);

    expect(buildCodexArgs(
      "/opt/codex",
      "reviewer_followup",
      "review-session",
      "/tmp/review-schema.json",
      ["/tmp/review.png"],
    )).toEqual([
      "/opt/codex",
      "exec",
      "resume",
      "review-session",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "--image",
      "/tmp/review.png",
      "-",
    ]);
  });

  test("builds Codex reviewer invocation with read-only schema output", () => {
    expect(buildCodexArgs("/opt/codex", "reviewer", undefined, "/tmp/review-schema.json")).toEqual([
      "/opt/codex",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/tmp/review-schema.json",
      "-",
    ]);
  });

  test("keeps Codex reviewer follow-up resume read-only without formal review output", () => {
    expect(buildCodexArgs("/opt/codex", "reviewer_followup", "review-session-456", "/tmp/review-schema.json")).toEqual([
      "/opt/codex",
      "exec",
      "resume",
      "review-session-456",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "-",
    ]);
  });

  test("builds Claude developer invocation with user permissions and exact-session resume", () => {
    expect(buildClaudeArgs("/opt/claude", "developer_feedback", "developer-session-456")).toEqual([
      "/opt/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      "developer-session-456",
    ]);
  });

  test("builds Claude reviewer invocation with read-only permissions and optional resume", () => {
    const args = buildClaudeArgs("/opt/claude", "reviewer", "review-session-456");

    expect(args).toEqual([
      "/opt/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--permission-mode",
      "plan",
      "--json-schema",
      JSON.stringify(reviewJsonSchema),
      "--tools",
      "Read",
      "Glob",
      "Grep",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "--resume",
      "review-session-456",
    ]);
    expect(args.some((argument) => argument.includes("Bash"))).toBe(false);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("-c");
  });

  test("keeps Claude reviewer follow-up resume read-only without formal review output", () => {
    expect(buildClaudeArgs("/opt/claude", "reviewer_followup", "review-session-456")).toEqual([
      "/opt/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--permission-mode",
      "plan",
      "--tools",
      "Read",
      "Glob",
      "Grep",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "--resume",
      "review-session-456",
    ]);
  });
});

describe("diagnostic redaction", () => {
  test("redacts credential keys and common bearer/token formats recursively", () => {
    const value = {
      stderr: "OPENAI_API_KEY=sk-live-secret Authorization: Bearer bearer-secret",
      nested: {
        ANTHROPIC_AUTH_TOKEN: "token-value",
        message: "request used sk-ant-api03-longsecret",
      },
    };

    const redacted = redactSensitive(value);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("sk-ant-api03-longsecret");
    expect(serialized).toContain("[REDACTED]");
  });

  test("redacts sensitive values inside raw JSON strings", () => {
    const raw = JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "plain-json-secret" });

    const redacted = redactSensitive(raw);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("plain-json-secret");
  });
});

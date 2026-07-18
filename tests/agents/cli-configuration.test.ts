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
  test("builds Codex initial and exact-session resume invocations", () => {
    expect(buildCodexArgs("/opt/codex")).toEqual([
      "/opt/codex",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-",
    ]);

    expect(buildCodexArgs("/opt/codex", "thread-exact-123")).toEqual([
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

  test("builds Claude stream-json invocation with read-only permissions and optional resume", () => {
    const args = buildClaudeArgs("/opt/claude", "review-session-456");

    expect(args.slice(0, 8)).toEqual([
      "/opt/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
      "--json-schema",
    ]);
    expect(JSON.parse(args[8] ?? "")).toEqual(reviewJsonSchema);
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Bash(git diff *)");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Edit");
    expect(args).toContain("Bash(git push *)");
    expect(args.slice(-2)).toEqual(["--resume", "review-session-456"]);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("-c");
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

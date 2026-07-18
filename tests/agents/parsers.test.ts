import { describe, expect, test } from "bun:test";
import { agentEventSchema } from "../../packages/shared/src";
import { parseClaudeEventLine } from "../../apps/server/src/drivers/claude-event.parser";
import { parseCodexEventLine } from "../../apps/server/src/drivers/codex-event.parser";

const context = {
  projectId: "project-1",
  taskId: "task-1",
  runId: "run-1",
};

describe("Codex JSONL parser", () => {
  test("emits only public event fields when given an extended driver request", () => {
    const extendedContext = {
      ...context,
      workingDirectory: "/private/repository",
      prompt: "private implementation prompt",
      sessionId: "existing-session",
    };

    const parsed = parseCodexEventLine(JSON.stringify({ type: "turn.started" }), extendedContext);

    expect(agentEventSchema.safeParse(parsed.event).success).toBe(true);
    expect(parsed.event).not.toHaveProperty("workingDirectory");
    expect(parsed.event).not.toHaveProperty("prompt");
    expect(parsed.event).not.toHaveProperty("sessionId");
  });

  test("extracts exact session and terminal information from complete events", () => {
    const session = parseCodexEventLine(JSON.stringify({
      type: "thread.started",
      thread_id: "thread-exact-123",
    }), context);
    const message = parseCodexEventLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "Implemented the task." },
    }), context);
    const completed = parseCodexEventLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 5 },
    }), context);

    expect(session.event.type).toBe("session_started");
    expect(session.sessionId).toBe("thread-exact-123");
    expect(session.event.payload).toMatchObject({ raw: expect.any(String) });
    expect(message.event.type).toBe("message");
    expect(message.finalMessage).toBe("Implemented the task.");
    expect(completed.event.type).toBe("turn_completed");
    expect(completed.completed).toBe(true);
  });

  test("preserves unknown JSON and invalid lines as raw events", () => {
    const unknownRaw = JSON.stringify({ type: "future.event", future_payload: { value: 7 } });
    const unknown = parseCodexEventLine(unknownRaw, context);
    const invalid = parseCodexEventLine("{not-json", context);

    expect(unknown.event?.type).toBe("raw");
    expect(unknown.event?.payload).toEqual({ raw: unknownRaw, parsed: JSON.parse(unknownRaw) });
    expect(invalid.event?.type).toBe("raw");
    expect(invalid.event?.payload).toMatchObject({ raw: "{not-json", parseError: expect.any(String) });
  });

  test("maps web search, todo list and reasoning items to typed events instead of raw", () => {
    const search = parseCodexEventLine(JSON.stringify({
      type: "item.started",
      item: { id: "item-1", type: "web_search", query: "release best practices" },
    }), context);
    const todo = parseCodexEventLine(JSON.stringify({
      type: "item.updated",
      item: { id: "item-2", type: "todo_list", items: [{ text: "step", completed: false }] },
    }), context);
    const reasoning = parseCodexEventLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item-3", type: "reasoning", text: "Considering the workflow." },
    }), context);

    expect(search.event?.type).toBe("tool");
    expect(todo.event?.type).toBe("plan");
    expect(reasoning.event?.type).toBe("message");
    expect(reasoning.finalMessage).toBeUndefined();
  });
});

describe("Claude stream-json parser", () => {
  test("extracts the complete result structure rather than assistant text", () => {
    const structuredOutput = {
      summary: "One issue found.",
      verdict: "changes_suggested",
      findings: [{
        severity: "P1",
        title: "Missing guard",
        description: "The input is not guarded.",
        suggestion: "Validate the input.",
        file: "src/input.ts",
        startLine: 7,
        endLine: 9,
      }],
    };
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 151,
      duration_api_ms: 120,
      num_turns: 1,
      result: "Review complete.",
      session_id: "claude-session-exact-456",
      total_cost_usd: 0,
      usage: { input_tokens: 44, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      structured_output: structuredOutput,
    });

    const parsed = parseClaudeEventLine(raw, context);

    expect(parsed.event.type).toBe("turn_completed");
    expect(parsed.sessionId).toBe("claude-session-exact-456");
    expect(parsed.finalMessage).toBe("Review complete.");
    expect(parsed.structuredOutput).toEqual(structuredOutput);
    expect(parsed.completed).toBe(true);
  });

  test("preserves a full assistant event and future/invalid lines", () => {
    const assistantRaw = JSON.stringify({
      type: "assistant",
      session_id: "claude-session-exact-456",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-test-model",
        content: [{ type: "text", text: "Reviewing changes." }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    });
    const unknownRaw = JSON.stringify({ type: "future_claude_event", session_id: "session-1", data: { ok: true } });

    const assistant = parseClaudeEventLine(assistantRaw, context);
    const unknown = parseClaudeEventLine(unknownRaw, context);
    const invalid = parseClaudeEventLine("not-json", context);

    expect(assistant.event?.type).toBe("message");
    expect(assistant.finalMessage).toBe("Reviewing changes.");
    expect(assistant.event?.payload).toMatchObject({ raw: assistantRaw, parsed: expect.any(Object) });
    expect(unknown.event?.type).toBe("raw");
    expect(unknown.event?.payload).toEqual({ raw: unknownRaw, parsed: JSON.parse(unknownRaw) });
    expect(invalid.event?.type).toBe("raw");
    expect(invalid.event?.payload).toMatchObject({ raw: "not-json", parseError: expect.any(String) });
  });

  test("drops thinking heartbeats and maps tool results to tool events", () => {
    const heartbeat = parseClaudeEventLine(JSON.stringify({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 50,
      session_id: "session-1",
    }), context);
    const toolResult = parseClaudeEventLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "diff --git a/file b/file" }],
      },
      session_id: "session-1",
    }), context);

    expect(heartbeat.event).toBeUndefined();
    expect(toolResult.event?.type).toBe("tool");
  });
});

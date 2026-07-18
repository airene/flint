import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@local-pair-review/shared";
import {
  EventService,
  type EventPersistencePort,
  type PersistAgentEventInput,
} from "../../apps/server/src/services/event.service";

function event(payload: unknown = { raw: "OPENAI_API_KEY=sk-secret-value", parsed: { type: "future" } }): AgentEvent {
  return {
    sequence: 0,
    timestamp: "2026-07-18T00:00:00.000Z",
    projectId: "project-1",
    taskId: "task-1",
    runId: "run-1",
    source: "codex",
    type: "raw",
    payload,
  };
}

describe("EventService", () => {
  test("persists a redacted raw event before broadcasting its assigned task sequence", async () => {
    const order: string[] = [];
    const persistedInputs: PersistAgentEventInput[] = [];
    const persistence: EventPersistencePort = {
      async append(input) {
        order.push("persist");
        persistedInputs.push(input);
        return { ...input.event, sequence: 17 };
      },
    };
    const broadcasts: AgentEvent[] = [];
    const service = new EventService(persistence, {
      async broadcast(persisted) {
        order.push("broadcast");
        broadcasts.push(persisted);
      },
    });

    const saved = await service.publish(event());

    expect(order).toEqual(["persist", "broadcast"]);
    expect(saved.sequence).toBe(17);
    expect(broadcasts).toEqual([saved]);
    expect(persistedInputs[0]?.rawJson).toContain("[REDACTED]");
    expect(JSON.stringify(persistedInputs[0]?.event)).not.toContain("sk-secret-value");
  });

  test("does not broadcast when persistence fails", async () => {
    const persistence: EventPersistencePort = {
      async append() {
        throw new Error("database unavailable");
      },
    };
    let broadcasted = false;
    const service = new EventService(persistence, {
      async broadcast() { broadcasted = true; },
    });

    await expect(service.publish(event({ raw: "complete raw event" }))).rejects.toThrow("database unavailable");
    expect(broadcasted).toBe(false);
  });

  test("does not let a slow client broadcast block persisted CLI output", async () => {
    const service = new EventService({
      async append(input) { return { ...input.event, sequence: 1 }; },
    }, {
      async broadcast() { await new Promise(() => {}); },
    });

    const outcome = await Promise.race([
      service.publish(event({ raw: "persist me" })).then(() => "persisted"),
      Bun.sleep(25).then(() => "blocked"),
    ]);

    expect(outcome).toBe("persisted");
  });

  test("redacts generic sensitive JSON keys in raw and normalized payloads", async () => {
    let persisted: PersistAgentEventInput | undefined;
    const service = new EventService({
      async append(input) {
        persisted = input;
        return { ...input.event, sequence: 1 };
      },
    }, { broadcast() {} });
    const raw = JSON.stringify({
      access_token: "access-secret",
      authorization: "Basic auth-secret",
      cookie: "session=cookie-secret",
      nested: { password: "password-secret", client_secret: "client-secret" },
    });

    await service.publish(event({ raw, parsed: JSON.parse(raw) }));

    const stored = JSON.stringify(persisted);
    for (const secret of ["access-secret", "auth-secret", "cookie-secret", "password-secret", "client-secret"]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain("access_token");
    expect(stored).toContain("client_secret");
    expect(stored).toContain("[REDACTED]");
  });
});

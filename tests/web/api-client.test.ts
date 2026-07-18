import { describe, expect, test } from "bun:test";
import { feedbackPreviewResponseSchema, healthResponseSchema } from "../../packages/shared/src/index";
import { ApiClientError, createApiClient, type ApiClient, type ApiRequestOptions, type ResponseSchema } from "../../apps/web/src/api/client";
import { createApiEndpoints } from "../../apps/web/src/api/endpoints";

describe("typed API client", () => {
  test("encodes query values and validates successful responses", async () => {
    let requestedUrl = "";
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:3000",
      fetcher: async (input) => {
        requestedUrl = String(input);
        return Response.json({ finalText: "diff --git" });
      },
    });

    const result = await client.request("/api/tasks/task%201/git/file-diff", feedbackPreviewResponseSchema, {
      query: { path: "src/a b+#?.ts", ignored: undefined },
    });

    expect(requestedUrl).toBe("http://127.0.0.1:3000/api/tasks/task%201/git/file-diff?path=src%2Fa+b%2B%23%3F.ts");
    expect(result).toEqual({ finalText: "diff --git" });
  });

  test("serializes JSON bodies without mutating caller headers", async () => {
    let requestedInit: RequestInit | undefined;
    const callerHeaders = new Headers({ "x-request-id": "request-1" });
    const client = createApiClient({
      fetcher: async (_input, init) => {
        requestedInit = init;
        return Response.json({ status: "ok" });
      },
    });

    await client.request("/api/example", healthResponseSchema, {
      method: "POST",
      body: { enabled: true },
      headers: callerHeaders,
    });

    const sentHeaders = new Headers(requestedInit?.headers);
    expect(sentHeaders.get("accept")).toBe("application/json");
    expect(sentHeaders.get("content-type")).toBe("application/json");
    expect(sentHeaders.get("x-request-id")).toBe("request-1");
    expect(callerHeaders.has("accept")).toBe(false);
    expect(requestedInit?.body).toBe(JSON.stringify({ enabled: true }));
  });

  test("throws ApiClientError with the stable server error fields", async () => {
    const client = createApiClient({
      fetcher: async () => Response.json({
        code: "CONFLICT",
        message: "Explicit confirmation is required.",
        details: { files: ["README.md"] },
      }, { status: 409 }),
    });

    const rejected = client.request("/api/projects/project-1/tasks", healthResponseSchema);

    await expect(rejected).rejects.toEqual(expect.objectContaining({
      name: "ApiClientError",
      status: 409,
      code: "CONFLICT",
      message: "Explicit confirmation is required.",
      details: { files: ["README.md"] },
    }));
  });

  test("normalizes malformed error and success payloads", async () => {
    const malformedError = createApiClient({
      fetcher: async () => new Response("not-json", { status: 500 }),
    });
    const invalidSuccess = createApiClient({
      fetcher: async () => Response.json({ status: "unexpected" }),
    });

    await expect(malformedError.request("/api/example", healthResponseSchema)).rejects.toEqual(expect.objectContaining({
      status: 500,
      code: "INTERNAL_ERROR",
    }));
    await expect(invalidSuccess.request(
      "/api/health",
      healthResponseSchema,
    )).rejects.toBeInstanceOf(ApiClientError);
    await expect(invalidSuccess.request(
      "/api/health",
      healthResponseSchema,
    )).rejects.toEqual(expect.objectContaining({
      status: 200,
      code: "INTERNAL_ERROR",
    }));
  });

  test("normalizes transport failures while preserving aborts", async () => {
    const failed = createApiClient({
      fetcher: async () => { throw new TypeError("connection refused"); },
    });
    const aborted = createApiClient({
      fetcher: async () => { throw new DOMException("cancelled", "AbortError"); },
    });

    await expect(failed.request("/api/health", healthResponseSchema)).rejects.toEqual(expect.objectContaining({
      status: 0,
      code: "INTERNAL_ERROR",
      message: "connection refused",
    }));
    await expect(aborted.request("/api/health", healthResponseSchema)).rejects.toEqual(expect.objectContaining({
      name: "AbortError",
    }));
  });
});

describe("API endpoints", () => {
  test("covers every HTTP route with encoded resource identifiers", async () => {
    const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
    const client: ApiClient = {
      async request<T>(path: string, _schema: ResponseSchema<T>, options?: ApiRequestOptions): Promise<T> {
        calls.push({ path, options });
        return {} as T;
      },
    };
    const api = createApiEndpoints(client);
    const projectId = "project / one";
    const taskId = "task / one";
    const runId = "run / one";
    const findingId = "finding / one";

    await api.health();
    await api.getCliStatus();
    await api.recheckClis({ codexExecutable: "/opt/codex", claudeExecutable: null });
    await api.listProjects();
    await api.createProject({ rootPath: "/work/project" });
    await api.getProject(projectId);
    await api.updateProject(projectId, { name: "Renamed" });
    await api.deleteProject(projectId, { confirm: true });
    await api.listTasks(projectId);
    await api.createTask(projectId, { title: "Task", originalPrompt: "Implement it" });
    await api.getTask(taskId);
    await api.updateTask(taskId, { title: "Updated" });
    await api.completeTask(taskId);
    await api.developTask(taskId, { prompt: "Continue" });
    await api.reviewTask(taskId);
    await api.sendFeedback(taskId, {
      sourceReviewRunId: "review-1",
      selectedFindingIds: ["finding-1"],
      finalText: "Fix it",
      confirmStaleSnapshot: false,
    });
    await api.cancelRun(runId);
    await api.getRun(runId);
    await api.listRuns(taskId);
    await api.getGitStatus(taskId);
    await api.getGitDiff(taskId);
    await api.getGitFiles(taskId);
    await api.getGitFileDiff(taskId, "src/a b+#?.ts");
    await api.listFindings(taskId);
    await api.updateFinding(findingId, { selected: true });
    await api.selectFindings(taskId, { mode: "P0_P1" });
    await api.previewFeedback(taskId, {
      sourceReviewRunId: "review-1",
      selectedFindingIds: ["finding-1"],
    });

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/health",
      "/api/system/clis",
      "/api/system/clis/recheck",
      "/api/projects",
      "/api/projects",
      "/api/projects/project%20%2F%20one",
      "/api/projects/project%20%2F%20one",
      "/api/projects/project%20%2F%20one",
      "/api/projects/project%20%2F%20one/tasks",
      "/api/projects/project%20%2F%20one/tasks",
      "/api/tasks/task%20%2F%20one",
      "/api/tasks/task%20%2F%20one",
      "/api/tasks/task%20%2F%20one/complete",
      "/api/tasks/task%20%2F%20one/develop",
      "/api/tasks/task%20%2F%20one/review",
      "/api/tasks/task%20%2F%20one/feedback",
      "/api/runs/run%20%2F%20one/cancel",
      "/api/runs/run%20%2F%20one",
      "/api/tasks/task%20%2F%20one/runs",
      "/api/tasks/task%20%2F%20one/git/status",
      "/api/tasks/task%20%2F%20one/git/diff",
      "/api/tasks/task%20%2F%20one/git/files",
      "/api/tasks/task%20%2F%20one/git/file-diff",
      "/api/tasks/task%20%2F%20one/findings",
      "/api/findings/finding%20%2F%20one",
      "/api/tasks/task%20%2F%20one/findings/select",
      "/api/tasks/task%20%2F%20one/feedback/preview",
    ]);
    expect(calls[2]?.options).toMatchObject({
      method: "POST",
      body: { codexExecutable: "/opt/codex", claudeExecutable: null },
    });
    expect(calls[7]?.options).toMatchObject({ method: "DELETE", body: { confirm: true } });
    expect(calls[22]?.options?.query).toEqual({ path: "src/a b+#?.ts" });
  });
});

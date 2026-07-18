import type { ZodType } from "zod";
import {
  cancelRunRequestSchema,
  cliRecheckRequestSchema,
  completeTaskRequestSchema,
  createProjectRequestSchema,
  createTaskRequestSchema,
  deleteProjectRequestSchema,
  developTaskRequestSchema,
  feedbackPreviewRequestSchema,
  feedbackTaskRequestSchema,
  reviewTaskRequestSchema,
  selectFindingsRequestSchema,
  updateFindingRequestSchema,
  updateProjectRequestSchema,
  updateTaskRequestSchema,
  type AgentAvailability,
  type AgentEvent,
  type AgentRun,
  type CliStatusResponse,
  type CliRecheckRequest,
  type Project,
  type ReviewFinding,
  type Task,
  webSocketSubscribeSchema,
} from "@local-pair-review/shared";
import { createDatabase, type AppDatabase } from "../db/database";
import { ClaudeCliDriver } from "../drivers/claude-cli.driver";
import { checkGitAvailability } from "../drivers/cli-availability";
import { CodexCliDriver } from "../drivers/codex-cli.driver";
import { AgentRunService } from "../services/agent-run.service";
import { AppSettingsService } from "../services/app-settings.service";
import { EventService } from "../services/event.service";
import { FeedbackService, composeFeedback } from "../services/feedback.service";
import { GitService } from "../services/git.service";
import { ProjectService } from "../services/project.service";
import { ReviewService, type ReviewContextPort } from "../services/review.service";
import { TaskService } from "../services/task.service";
import { DatabasePorts } from "./database-ports";
import { CliUnavailableError, errorResponse, NotFoundError, RunConflictError, ServiceShuttingDownError, StaleSnapshotError } from "./errors";
import { EventHub, type EventSocket } from "./event-hub";

export interface ApplicationOptions {
  databasePath?: string;
  codexExecutable?: string;
  claudeExecutable?: string;
  gitExecutable?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface LocalPairReviewApplication {
  readonly hub: EventHub;
  handle(request: Request): Promise<Response>;
  socketOpen(socket: EventSocket): void;
  socketMessage(socket: EventSocket, rawMessage: string | Uint8Array): Promise<void>;
  socketClose(socket: EventSocket): void;
  shutdown(): Promise<void>;
}

function match(pathname: string, expression: RegExp): string[] | null {
  const result = expression.exec(pathname);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

async function body<T>(request: Request, schema: ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new SyntaxError("Write requests require application/json.");
  }
  const text = await request.text();
  return schema.parse(text ? JSON.parse(text) : {});
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function eventFor(run: AgentRun, type: AgentEvent["type"], timestamp: string): AgentEvent {
  return {
    sequence: 0,
    timestamp,
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    source: "system",
    type,
    payload: { recovered: true },
  };
}

export async function createApplication(options: ApplicationOptions = {}): Promise<LocalPairReviewApplication> {
  const environment = options.environment ?? process.env;
  const database = createDatabase(options.databasePath ?? ":memory:");
  const settings = new AppSettingsService(database, {
    codexExecutable: options.codexExecutable ?? "codex",
    claudeExecutable: options.claudeExecutable ?? "claude",
    gitExecutable: options.gitExecutable ?? "git",
  });
  let cliExecutables = settings.loadCliExecutables();
  let gitExecutable = cliExecutables.gitExecutable;
  const git = new GitService(gitExecutable);
  const projects = new ProjectService(database, gitExecutable);
  const tasks = new TaskService(database, git);
  const ports = new DatabasePorts(database, git);
  const hub = new EventHub();
  const events = new EventService(ports, hub);
  const codex = new CodexCliDriver({
    executablePath: cliExecutables.codexExecutable,
    environment,
    availabilityWorkingDirectory: process.cwd(),
  });
  const claude = new ClaudeCliDriver({
    executablePath: cliExecutables.claudeExecutable,
    environment,
    availabilityWorkingDirectory: process.cwd(),
  });
  const agentRuns = new AgentRunService({
    drivers: { codex, claude },
    persistence: ports,
    taskState: ports,
    events,
  });
  const reviewContext: ReviewContextPort = {
    async capture(task) {
      const [status, diff, snapshotHash] = await Promise.all([
        git.status(task.workingDirectory),
        git.diff(task.workingDirectory, task.baseCommit),
        git.snapshotHash(task.workingDirectory, task.baseCommit),
      ]);
      return { snapshotHash, gitStatus: JSON.stringify(status.files), diffStat: diff.stat };
    },
  };
  const reviews = new ReviewService({ agentRuns, context: reviewContext, persistence: ports, events });
  const feedback = new FeedbackService({ agentRuns, persistence: ports });
  const active = new Map<string, Promise<AgentRun>>();
  let accepting = true;
  let cliStatus: CliStatusResponse | null = null;

  function track(runId: string, completion: Promise<AgentRun> | Promise<{ run: AgentRun }>): void {
    const terminal = completion.then((result) => "run" in result ? result.run : result);
    active.set(runId, terminal);
    void terminal.catch(() => undefined).finally(() => active.delete(runId));
  }

  async function clis(recheck = false): Promise<CliStatusResponse> {
    if (!cliStatus || recheck) {
      const [codexStatus, claudeStatus, gitStatus] = await Promise.all([
        codex.checkAvailability(),
        claude.checkAvailability(),
        checkGitAvailability(gitExecutable, environment, process.cwd()),
      ]);
      cliStatus = { codex: codexStatus, claude: claudeStatus, git: gitStatus };
    }
    return cliStatus;
  }

  async function requireCli(provider: "codex" | "claude" | "git"): Promise<AgentAvailability> {
    const availability = (await clis())[provider];
    if (!availability.installed || availability.authentication === "unauthenticated") {
      throw new CliUnavailableError(provider, availability.message ?? `${provider} is unavailable or not authenticated.`);
    }
    return availability;
  }

  async function requireTask(taskId: string): Promise<Task> {
    const task = await tasks.get(taskId);
    if (!task) throw new NotFoundError("Task");
    return task;
  }

  async function requireProject(projectId: string): Promise<Project> {
    const project = await projects.get(projectId);
    if (!project) throw new NotFoundError("Project");
    return project;
  }

  async function requireRun(runId: string): Promise<AgentRun> {
    const run = await ports.getRun(runId);
    if (!run) throw new NotFoundError("Run");
    return run;
  }

  function ensureAccepting(): void {
    if (!accepting) throw new ServiceShuttingDownError();
  }

  try {
    const recovered = await ports.recoverInterrupted();
    for (const run of recovered) await events.publish(eventFor(run, "run_interrupted", new Date().toISOString()));
  } catch (error) {
    database.close();
    throw error;
  }

  async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method === "GET" && path === "/api/health") return json({ status: "ok" });
      if (method === "GET" && path === "/api/system/clis") return json(await clis());
      if (method === "POST" && path === "/api/system/clis/recheck") {
        const input: CliRecheckRequest = await body(request, cliRecheckRequestSchema);
        if (Object.keys(input).length > 0) {
          cliExecutables = settings.updateCliExecutables(input);
          gitExecutable = cliExecutables.gitExecutable;
          codex.setExecutablePath(cliExecutables.codexExecutable);
          claude.setExecutablePath(cliExecutables.claudeExecutable);
          git.setExecutablePath(gitExecutable);
          projects.setGitExecutablePath(gitExecutable);
          cliStatus = null;
        }
        return json(await clis(true));
      }

      if (method === "GET" && path === "/api/projects") return json(await projects.list());
      if (method === "POST" && path === "/api/projects") {
        ensureAccepting();
        await requireCli("git");
        const input = await body(request, createProjectRequestSchema);
        return json(await projects.add(input.rootPath), 201);
      }

      let parameters = match(path, /^\/api\/projects\/([^/]+)$/);
      if (parameters) {
        const [projectId] = parameters;
        if (method === "GET") return json(await requireProject(projectId!));
        if (method === "PATCH") {
          ensureAccepting();
          const input = await body(request, updateProjectRequestSchema);
          return json((await projects.update(projectId!, input)) ?? await requireProject(projectId!));
        }
        if (method === "DELETE") {
          ensureAccepting();
          const input = await body(request, deleteProjectRequestSchema);
          await projects.remove(projectId!, input.confirm);
          return json({ deleted: true });
        }
      }

      parameters = match(path, /^\/api\/projects\/([^/]+)\/tasks$/);
      if (parameters) {
        const [projectId] = parameters;
        await requireProject(projectId!);
        if (method === "GET") return json(await tasks.list(projectId!));
        if (method === "POST") {
          ensureAccepting();
          const input = await body(request, createTaskRequestSchema);
          return json(await tasks.create(projectId!, input), 201);
        }
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)$/);
      if (parameters) {
        const [taskId] = parameters;
        if (method === "GET") return json(await requireTask(taskId!));
        if (method === "PATCH") {
          ensureAccepting();
          const input = await body(request, updateTaskRequestSchema);
          return json((await tasks.update(taskId!, input)) ?? await requireTask(taskId!));
        }
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/complete$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await body(request, completeTaskRequestSchema);
        return json(await tasks.complete(parameters[0]!));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/develop$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await requireCli("codex");
        const input = await body(request, developTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        const initial = task.status === "draft";
        if (!initial && !task.developerSessionId) throw new RunConflictError("Continuing development requires an exact Codex session ID.");
        const started = await agentRuns.start({
          task,
          runType: initial ? "developer_initial" : "developer_feedback",
          prompt: input.prompt ?? (initial ? task.originalPrompt : "继续处理当前任务，并总结本轮变更。"),
          ...(initial ? {} : { sessionId: task.developerSessionId! }),
        });
        track(started.run.id, started.completion);
        return json({ task: await requireTask(task.id), run: started.run }, 202);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/review$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await requireCli("claude");
        await body(request, reviewTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        const started = await reviews.start(task);
        track(started.run.id, started.completion);
        return json({ task: await requireTask(task.id), run: started.run }, 202);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/feedback$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await requireCli("codex");
        const input = await body(request, feedbackTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        const sourceRun = await requireRun(input.sourceReviewRunId);
        if (sourceRun.taskId !== task.id || sourceRun.runType !== "reviewer") {
          throw new RunConflictError("Feedback must reference a reviewer run from this task.");
        }
        const availableFindings = await ports.listFindings(task.id);
        const selectedIds = new Set(input.selectedFindingIds);
        if (selectedIds.size !== input.selectedFindingIds.length || input.selectedFindingIds.some((id) => (
          !availableFindings.some((finding) => finding.id === id && finding.runId === sourceRun.id && !finding.dismissed)
        ))) {
          throw new RunConflictError("Feedback contains an invalid, dismissed, or unrelated finding.");
        }
        if (task.latestSnapshotHash) {
          const current = await git.snapshotHash(task.workingDirectory, task.baseCommit);
          if (current !== task.latestSnapshotHash && !input.confirmStaleSnapshot) throw new StaleSnapshotError();
        }
        const started = await feedback.send({
          task,
          sourceReviewRunId: input.sourceReviewRunId,
          selectedFindingIds: input.selectedFindingIds,
          finalText: input.finalText,
        });
        track(started.run.id, started.completion);
        return json({ task: await requireTask(task.id), run: started.run, delivery: started.delivery }, 202);
      }

      parameters = match(path, /^\/api\/runs\/([^/]+)\/cancel$/);
      if (parameters && method === "POST") {
        await body(request, cancelRunRequestSchema);
        const run = await requireRun(parameters[0]!);
        await agentRuns.cancel(run.id);
        const terminal = active.get(run.id);
        return json(terminal ? await terminal : await requireRun(run.id));
      }

      parameters = match(path, /^\/api\/runs\/([^/]+)$/);
      if (parameters && method === "GET") return json(await requireRun(parameters[0]!));

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/runs$/);
      if (parameters && method === "GET") {
        await requireTask(parameters[0]!);
        return json(await ports.listRuns(parameters[0]!));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/git\/(status|diff|files)$/);
      if (parameters && method === "GET") {
        const task = await requireTask(parameters[0]!);
        if (parameters[1] === "status") {
          const [status, snapshotHash] = await Promise.all([
            git.status(task.workingDirectory),
            git.snapshotHash(task.workingDirectory, task.baseCommit),
          ]);
          return json({ ...status, snapshotHash });
        }
        if (parameters[1] === "diff") return json(await git.diff(task.workingDirectory, task.baseCommit));
        return json(await git.files(task.workingDirectory));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/git\/file-diff$/);
      if (parameters && method === "GET") {
        const task = await requireTask(parameters[0]!);
        const filePath = url.searchParams.get("path");
        if (!filePath) throw new SyntaxError("path query parameter is required");
        return json(await git.fileDiff(task.workingDirectory, task.baseCommit, filePath));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/findings$/);
      if (parameters && method === "GET") {
        await requireTask(parameters[0]!);
        return json(await ports.listFindings(parameters[0]!));
      }

      parameters = match(path, /^\/api\/findings\/([^/]+)$/);
      if (parameters && method === "PATCH") {
        ensureAccepting();
        const input = await body(request, updateFindingRequestSchema);
        const finding = await ports.updateFinding(parameters[0]!, input);
        if (!finding) throw new NotFoundError("Finding");
        return json(finding);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/findings\/select$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await requireTask(parameters[0]!);
        const input = await body(request, selectFindingsRequestSchema);
        return json(await ports.selectFindings(parameters[0]!, input.mode));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/feedback\/preview$/);
      if (parameters && method === "POST") {
        const task = await requireTask(parameters[0]!);
        const input = await body(request, feedbackPreviewRequestSchema);
        const selected = new Set(input.selectedFindingIds);
        const available = await ports.listFindings(task.id);
        if (selected.size !== input.selectedFindingIds.length || input.selectedFindingIds.some((id) => !available.some((finding) => finding.id === id && !finding.dismissed))) {
          throw new RunConflictError("Feedback preview contains an invalid or dismissed finding.");
        }
        const findings = available.map((finding) => ({ ...finding, selected: selected.has(finding.id) }));
        return json({ finalText: composeFeedback(task, findings) });
      }

      return json({ code: "NOT_FOUND", message: "Route not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  try {
    await clis(true);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    hub,
    handle,
    socketOpen(socket) { hub.open(socket); },
    async socketMessage(socket, rawMessage) {
      const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { socket.close(1008, "Invalid subscription message"); return; }
      const subscription = webSocketSubscribeSchema.safeParse(parsed);
      if (!subscription.success || !(await tasks.get(subscription.data.taskId))) {
        socket.close(1008, "Invalid subscription message");
        return;
      }
      hub.beginReplay(socket, subscription.data.taskId);
      try {
        socket.send(JSON.stringify({ ...subscription.data, action: "subscribed" }));
        let lastSequence = subscription.data.afterSequence;
        for (const event of await ports.replay(subscription.data.taskId, lastSequence)) {
          if (!hub.sendReplay(socket, event)) return;
          lastSequence = event.sequence;
        }
        hub.finishReplay(socket, lastSequence);
      } catch {
        hub.close(socket);
        try { socket.close(1011, "Event replay failed; reconnect to retry"); } catch { /* already closed */ }
      }
    },
    socketClose(socket) { hub.close(socket); },
    async shutdown() {
      if (!accepting) return;
      accepting = false;
      const activeIds = [...active.keys()];
      try {
        await Promise.allSettled(activeIds.map((runId) => agentRuns.interrupt(runId)));
        await Promise.allSettled(activeIds.map((runId) => active.get(runId)).filter(Boolean) as Promise<AgentRun>[]);
        const stranded = await ports.recoverInterrupted(activeIds);
        for (const run of stranded) {
          try { await events.publish(eventFor(run, "run_interrupted", new Date().toISOString())); } catch { /* closing continues */ }
        }
      } finally {
        try { hub.closeAll(); } finally { database.close(); }
      }
    },
  };
}

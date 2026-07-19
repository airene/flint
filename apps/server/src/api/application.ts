import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ZodType } from "zod";
import {
  cancelRunRequestSchema,
  approvalDecisionRequestSchema,
  createTaskMessageRequestSchema,
  cliRecheckRequestSchema,
  completeTaskRequestSchema,
  createProjectRequestSchema,
  createTaskRequestSchema,
  deleteProjectRequestSchema,
  developTaskRequestSchema,
  feedbackPreviewRequestSchema,
  saveFeedbackDraftRequestSchema,
  feedbackTaskRequestSchema,
  markProjectOpenedRequestSchema,
  projectFilesRequestSchema,
  reviewTaskRequestSchema,
  selectFindingsRequestSchema,
  updateFindingRequestSchema,
  type AgentAvailability,
  type AgentEvent,
  type AgentRun,
  type ApprovalRequest,
  type Provider,
  type CliStatusResponse,
  type CliRecheckRequest,
  type SettingsResponse,
  type Project,
  type ReviewFinding,
  type Task,
  type TaskMessage,
  webSocketSubscribeSchema,
} from "@local-pair-review/shared";
import { createDatabase } from "../db/database";
import { ClaudeCliDriver } from "../drivers/claude-cli.driver";
import { checkGitAvailability } from "../drivers/cli-availability";
import { CodexCliDriver } from "../drivers/codex-cli.driver";
import { createTemporaryCodexReviewSchema } from "../drivers/codex-review-schema";
import { createProviderRegistry } from "../drivers/provider-registry";
import { AgentRunService } from "../services/agent-run.service";
import { AppSettingsService } from "../services/app-settings.service";
import { AttachmentService, AttachmentValidationError } from "../services/attachment.service";
import { EventService } from "../services/event.service";
import { FeedbackService, composeFeedback } from "../services/feedback.service";
import { GitService } from "../services/git.service";
import { ProjectService } from "../services/project.service";
import { ReviewService, type ReviewContextPort } from "../services/review.service";
import { TaskService } from "../services/task.service";
import { UnfinishedTaskService } from "../services/unfinished-task.service";
import { ConversationService } from "../services/conversation.service";
import { ApprovalService } from "../services/approval.service";
import { AttachmentClaimConflictError, DatabasePorts, PersistenceOwnershipError } from "./database-ports";
import { CliUnavailableError, errorResponse, NotFoundError, RequestValidationError, RunConflictError, ServiceShuttingDownError, StaleSnapshotError } from "./errors";
import { EventHub, type EventSocket } from "./event-hub";
import { createUnfinishedTasksRoute } from "./unfinished-tasks";
import { createRunEvent } from "../utils/agent-event";
import { UnsupportedProviderCapabilityError } from "../drivers/agent-control";

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
    throw new RequestValidationError("Write requests require application/json.");
  }
  const text = await request.text();
  if (!text) return schema.parse({});
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new RequestValidationError("Request body must be valid JSON.");
    throw error;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function eventFor(run: AgentRun, type: AgentEvent["type"], timestamp: string): AgentEvent {
  return createRunEvent(run, "system", type, { recovered: true }, timestamp);
}

const UNFINISHED_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "run_queued",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "approval_requested",
  "approval_resolved",
]);

export async function createApplication(options: ApplicationOptions = {}): Promise<LocalPairReviewApplication> {
  const environment = options.environment ?? process.env;
  const databasePath = options.databasePath ?? ":memory:";
  const database = createDatabase(databasePath);
  const settings = new AppSettingsService(database, {
    codexExecutable: options.codexExecutable ?? "codex",
    claudeExecutable: options.claudeExecutable ?? "claude",
    gitExecutable: options.gitExecutable ?? "git",
  });
  let cliExecutables = settings.loadCliExecutables();
  let gitExecutable = cliExecutables.gitExecutable;
  const git = new GitService(gitExecutable);
  const projects = new ProjectService(database, gitExecutable);
  const tasks = new TaskService(database, git, settings);
  const ports = new DatabasePorts(database, git, { instanceId: randomUUID() });
  const attachmentDataRoot = databasePath === ":memory:"
    ? join(tmpdir(), "flint-attachment-data")
    : dirname(resolve(databasePath));
  const attachments = new AttachmentService({ dataRoot: attachmentDataRoot, persistence: ports });
  const unfinishedTasks = new UnfinishedTaskService(ports);
  const unfinishedTasksRoute = createUnfinishedTasksRoute(unfinishedTasks);
  let leaseLost = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  try {
    ports.acquireApplicationLease();
  } catch (error) {
    database.close();
    throw error;
  }
  heartbeatTimer = setInterval(() => {
    try {
      if (!ports.heartbeatApplicationLease()) leaseLost = true;
    } catch {
      // Startup continues while transient SQLite locks are retried on the next heartbeat.
    }
  }, 1_000);
  heartbeatTimer.unref?.();
  const hub = new EventHub();
  async function broadcastUnfinishedTask(taskId: string): Promise<void> {
    try {
      const summary = (await unfinishedTasks.list()).find((candidate) => candidate.id === taskId);
      hub.broadcastUnfinished(summary
        ? { type: "unfinished_task_upsert", task: summary }
        : { type: "unfinished_task_remove", taskId });
    } catch {
      // The database is authoritative; a reconnect replaces the app-level snapshot.
    }
  }
  const events = new EventService(ports, {
    async broadcast(event) {
      hub.broadcast(event);
      if (UNFINISHED_EVENT_TYPES.has(event.type)) await broadcastUnfinishedTask(event.taskId);
    },
  });
  let codexReviewSchema: Awaited<ReturnType<typeof createTemporaryCodexReviewSchema>>;
  try {
    codexReviewSchema = await createTemporaryCodexReviewSchema();
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    ports.releaseApplicationLease();
    database.close();
    throw error;
  }
  const codex = new CodexCliDriver({
    executablePath: cliExecutables.codexExecutable,
    environment,
    availabilityWorkingDirectory: process.cwd(),
    reviewSchemaPath: codexReviewSchema.path,
  });
  const claude = new ClaudeCliDriver({
    executablePath: cliExecutables.claudeExecutable,
    environment,
    availabilityWorkingDirectory: process.cwd(),
  });
  const providerRegistry = createProviderRegistry({ codex, claude });
  const agentRuns = new AgentRunService({
    drivers: { codex, claude },
    persistence: ports,
    taskState: ports,
    events,
  });
  const reviewContext: ReviewContextPort = {
    async capture(task) {
      const capture = await git.capture(task.workingDirectory, task.baseCommit);
      return {
        snapshotHash: capture.snapshotHash,
        gitStatus: JSON.stringify(capture.status.files),
        diffStat: capture.diff.stat,
        trackedPatch: capture.diff.trackedPatch,
        untrackedPatch: capture.diff.untrackedPatch,
      };
    },
  };
  const reviews = new ReviewService({ agentRuns, context: reviewContext, persistence: ports, events });
  const feedback = new FeedbackService({ agentRuns, persistence: ports });
  const active = new Map<string, Promise<AgentRun>>();
  const approvalDecisions = new Map<string, Promise<ApprovalRequest>>();
  let accepting = true;
  let cliStatus: CliStatusResponse | null = null;
  let shutdownTask: Promise<void> | null = null;

  async function publishApprovalEvent(approval: ApprovalRequest): Promise<void> {
    const run = await ports.getRun(approval.runId);
    if (!run) return;
    try {
      await events.publish(createRunEvent(run, "system", "approval_resolved", {
        approvalId: approval.id,
        status: approval.status,
        decision: approval.decision,
      }));
    } catch {
      // Approval persistence is authoritative; the Activity stream can recover on refresh.
    }
  }

  const approvals = new ApprovalService({
    controls: { codex, claude },
    persistence: ports,
    security: {
      async recordSecurityError(runId, securityError) {
        const run = await ports.getRun(runId);
        if (run) await events.publish(createRunEvent(run, "system", "raw", { securityError }));
      },
    },
  });

  function track(runId: string, completion: Promise<AgentRun> | Promise<{ run: AgentRun }>): void {
    const terminal = completion.then((result) => "run" in result ? result.run : result);
    active.set(runId, terminal);
    void terminal.then(async (run) => {
      for (const approval of await approvals.expireRun(run)) await publishApprovalEvent(approval);
    }).catch(() => undefined).finally(() => active.delete(runId));
  }

  async function decideApproval(approvalId: string, decision: "allow_once" | "deny", reason: string | null): Promise<ApprovalRequest> {
    const pending = approvalDecisions.get(approvalId);
    if (pending) return await pending;
    const operation = (async () => {
      const before = await ports.getApproval(approvalId);
      const decided = await approvals.decide(approvalId, decision, reason);
      if (before.status === "pending" && decided.status !== "pending") await publishApprovalEvent(decided);
      return decided;
    })();
    approvalDecisions.set(approvalId, operation);
    try {
      return await operation;
    } finally {
      if (approvalDecisions.get(approvalId) === operation) approvalDecisions.delete(approvalId);
    }
  }

  async function publishMessageEvent(message: TaskMessage, type: "message_queued" | "message_delivered" | "message_failed"): Promise<void> {
    const runs = await ports.listRuns(message.taskId);
    const targetRun = type === "message_queued" && message.sourceReviewRunId
      ? runs.find((run) => run.id === message.sourceReviewRunId)
      : runs.filter((run) => message.targetRole === "reviewer"
        ? run.runType === "reviewer" || run.runType === "reviewer_followup"
        : run.runType !== "reviewer" && run.runType !== "reviewer_followup").at(-1);
    if (!targetRun) return;
    try {
      await events.publish(createRunEvent(targetRun, "system", type, {
        messageId: message.id,
        status: message.status,
        targetRole: message.targetRole,
      }));
    } catch {
      // Message persistence is authoritative; a stream outage must not duplicate delivery.
    }
  }

  const conversations = new ConversationService({
    persistence: {
      async createMessage(message, attachmentIds) {
        const persisted = await ports.createMessage(message, attachmentIds);
        await publishMessageEvent(persisted, "message_queued");
        return persisted;
      },
      async transitionMessage(messageId, from, patch) {
        const transitioned = await ports.transitionMessage(messageId, from, patch);
        if (transitioned?.status === "delivered") await publishMessageEvent(transitioned, "message_delivered");
        if (transitioned?.status === "failed") await publishMessageEvent(transitioned, "message_failed");
        return transitioned;
      },
      getTask: (taskId) => ports.getTask(taskId),
      getRun: (runId) => ports.getRun(runId),
      listRuns: (taskId) => ports.listRuns(taskId),
      listMessages: (taskId) => ports.listMessages(taskId),
      attachmentPaths: (messageIds) => ports.attachmentPaths(messageIds),
      discardIncompleteFormalFindings: (runId) => ports.discardIncompleteFormalFindings(runId),
    },
    agentRuns: {
      async start(input) {
        const started = await agentRuns.start(input);
        track(started.run.id, started.completion);
        return started;
      },
      interrupt: (runId) => agentRuns.interrupt(runId),
      waitForTerminal: (runId) => agentRuns.waitForTerminal(runId),
    },
  });

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

  async function settingsResponse(recheck = false): Promise<SettingsResponse> {
    const status = await clis(recheck);
    return {
      providers: providerRegistry.descriptors({ codex: status.codex, claude: status.claude }),
      git: status.git,
      roles: settings.loadAgentRoles(),
    };
  }

  function updateSettings(input: CliRecheckRequest): void {
    for (const [role, provider] of [
      ["developer", input.developerProvider],
      ["reviewer", input.reviewerProvider],
    ] as const) {
      if (!provider) continue;
      if (!providerRegistry.get(provider).roles.includes(role)) {
        throw new RequestValidationError(`${provider} does not support the ${role} role.`);
      }
    }

    const executableChanged = input.codexExecutable !== undefined
      || input.claudeExecutable !== undefined
      || input.gitExecutable !== undefined;
    const updated = settings.updateSettings(input);
    if (executableChanged) {
      cliExecutables = updated.cliExecutables;
      gitExecutable = cliExecutables.gitExecutable;
      codex.setExecutablePath(cliExecutables.codexExecutable);
      claude.setExecutablePath(cliExecutables.claudeExecutable);
      git.setExecutablePath(gitExecutable);
      projects.setGitExecutablePath(gitExecutable);
      cliStatus = null;
    }
  }

  async function requireCli(provider: Provider): Promise<AgentAvailability> {
    const availability = await providerRegistry.get(provider).driver.checkAvailability();
    if (cliStatus) cliStatus = { ...cliStatus, [provider]: availability };
    if (!availability.installed || availability.authentication === "unauthenticated") {
      throw new CliUnavailableError(provider, availability.message ?? `${provider} is unavailable or not authenticated.`);
    }
    return availability;
  }

  function requireImageCapability(
    provider: Provider,
    capability: "developerInitialImage" | "developerResumeImage" | "reviewerInitialImage" | "reviewerResumeImage",
    imagePathsOrIds: readonly string[],
  ): void {
    if (imagePathsOrIds.length && !providerRegistry.get(provider).driver.capabilities[capability]) {
      throw new UnsupportedProviderCapabilityError(provider, capability);
    }
  }

  async function requireGit(): Promise<AgentAvailability> {
    const availability = await checkGitAvailability(gitExecutable, environment, process.cwd());
    if (cliStatus) cliStatus = { ...cliStatus, git: availability };
    if (!availability.installed) {
      throw new CliUnavailableError("git", availability.message ?? "Git is unavailable or cannot be executed.");
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

  async function requireSuccessfulReviewRun(task: Task, sourceReviewRunId: string): Promise<AgentRun> {
    const sourceRun = await requireRun(sourceReviewRunId);
    if (
      sourceRun.taskId !== task.id
      || sourceRun.runType !== "reviewer"
      || sourceRun.status !== "completed"
      || sourceRun.reviewParseStatus !== "succeeded"
    ) {
      throw new RunConflictError("Feedback must reference a successfully parsed reviewer run from this task.");
    }
    return sourceRun;
  }

  async function feedbackFindings(
    task: Task,
    sourceReviewRunId: string,
    selectedFindingIds: string[],
  ): Promise<{ sourceRun: AgentRun; findings: ReviewFinding[] }> {
    const sourceRun = await requireSuccessfulReviewRun(task, sourceReviewRunId);
    const findings = (await ports.listFindings(task.id)).filter((finding) => finding.runId === sourceRun.id);
    const selected = new Set(selectedFindingIds);
    if (selected.size !== selectedFindingIds.length || selectedFindingIds.some((id) => (
      !findings.some((finding) => finding.id === id && finding.runId === sourceRun.id && !finding.dismissed)
    ))) {
      throw new RunConflictError("Feedback contains an invalid, dismissed, or unrelated finding.");
    }
    return { sourceRun, findings };
  }

  function ensureAccepting(): void {
    if (!accepting) throw new ServiceShuttingDownError();
  }

  try {
    const recovered = await ports.recoverInterrupted();
    for (const run of recovered) await events.publish(eventFor(run, "run_interrupted", new Date().toISOString()));
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { ports.releaseApplicationLease(); } finally { database.close(); }
    await codexReviewSchema.dispose();
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
        ensureAccepting();
        const input: CliRecheckRequest = await body(request, cliRecheckRequestSchema);
        updateSettings(input);
        return json(await clis(true));
      }
      if (method === "GET" && path === "/api/system/settings") return json(await settingsResponse());
      if (method === "POST" && path === "/api/system/settings") {
        ensureAccepting();
        const input: CliRecheckRequest = await body(request, cliRecheckRequestSchema);
        updateSettings(input);
        return json(await settingsResponse(true));
      }

      const unfinishedResponse = await unfinishedTasksRoute(request);
      if (unfinishedResponse) return unfinishedResponse;

      if (method === "GET" && path === "/api/projects") return json(await projects.list());
      if (method === "POST" && path === "/api/projects") {
        ensureAccepting();
        await requireGit();
        const input = await body(request, createProjectRequestSchema);
        return json(await projects.add(input.rootPath), 201);
      }

      let parameters = match(path, /^\/api\/projects\/([^/]+)$/);
      if (parameters) {
        const [projectId] = parameters;
        if (method === "GET") return json(await requireProject(projectId!));
        if (method === "PATCH") {
          ensureAccepting();
          const input = await body(request, markProjectOpenedRequestSchema);
          return json((await projects.markOpened(projectId!, input.lastOpenedAt)) ?? await requireProject(projectId!));
        }
        if (method === "DELETE") {
          ensureAccepting();
          const input = await body(request, deleteProjectRequestSchema);
          await requireProject(projectId!);
          await projects.remove(projectId!, input.confirm);
          return json({ deleted: true });
        }
      }

      parameters = match(path, /^\/api\/projects\/([^/]+)\/files$/);
      if (parameters && method === "GET") {
        const project = await requireProject(parameters[0]!);
        const input = projectFilesRequestSchema.parse(Object.fromEntries(url.searchParams.entries()));
        await requireGit();
        return json(await git.projectFiles(project.id, project.rootPath, input.q ?? "", input.limit ?? 50));
      }

      parameters = match(path, /^\/api\/projects\/([^/]+)\/attachment-drafts$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        const project = await requireProject(parameters[0]!);
        try {
          const attachment = await attachments.createDraft(
            project.id,
            new Uint8Array(await request.arrayBuffer()),
            request.headers.get("content-type") ?? undefined,
          );
          return json({ id: attachment.id }, 201);
        } catch (error) {
          if (error instanceof AttachmentValidationError) throw new RequestValidationError(error.message);
          throw error;
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
          const attachmentIds = input.attachmentIds ?? [];
          await requireGit();
          const task = await tasks.create(projectId!, input);
          try {
            if (attachmentIds.length
              && !providerRegistry.get(task.developerProvider).driver.capabilities.developerInitialImage) {
              throw new RunConflictError(`${task.developerProvider} does not support developer initial-run images through its configured CLI protocol.`);
            }
            await attachments.claim(projectId!, task.id, attachmentIds);
          } catch (error) {
            await tasks.discardDraft(task.id);
            if (error instanceof AttachmentClaimConflictError || error instanceof PersistenceOwnershipError) {
              throw new RunConflictError(error.message);
            }
            throw error;
          }
          await broadcastUnfinishedTask(task.id);
          return json(task, 201);
        }
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)$/);
      if (parameters) {
        const [taskId] = parameters;
        if (method === "GET") return json(await requireTask(taskId!));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/complete$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await body(request, completeTaskRequestSchema);
        await requireTask(parameters[0]!);
        const completed = await tasks.complete(parameters[0]!);
        await broadcastUnfinishedTask(completed.id);
        return json(completed);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/develop$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        const input = await body(request, developTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        await requireCli(task.developerProvider);
        const initial = task.status === "draft";
        if (!initial && !task.developerSessionId) throw new RunConflictError("Continuing development requires an exact developer session ID.");
        const imagePaths = initial ? await ports.initialAttachmentPaths(task.id) : [];
        requireImageCapability(task.developerProvider, initial ? "developerInitialImage" : "developerResumeImage", imagePaths);
        const started = await agentRuns.start({
          task,
          runType: initial ? "developer_initial" : "developer_feedback",
          prompt: input.prompt ?? (initial ? task.originalPrompt : "Continue the current task and summarize the changes from this run."),
          ...(initial ? {} : { sessionId: task.developerSessionId! }),
          imagePaths,
        });
        track(started.run.id, started.completion);
        return json({ task: await requireTask(task.id), run: started.run }, 202);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/review$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        await body(request, reviewTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        await requireCli(task.reviewerProvider);
        await requireGit();
        const imagePaths = await ports.initialAttachmentPaths(task.id);
        requireImageCapability(task.reviewerProvider, "reviewerInitialImage", imagePaths);
        const started = await reviews.start(task, imagePaths);
        track(started.run.id, started.completion);
        return json({ task: await requireTask(task.id), run: started.run }, 202);
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/feedback$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        const input = await body(request, feedbackTaskRequestSchema);
        const task = await requireTask(parameters[0]!);
        await requireCli(task.developerProvider);
        const { sourceRun } = await feedbackFindings(task, input.sourceReviewRunId, input.selectedFindingIds);
        const draftNow = new Date().toISOString();
        await ports.saveFeedbackDraft({
          taskId: task.id,
          sourceReviewRunId: sourceRun.id,
          finalText: input.finalText,
          createdAt: draftNow,
          updatedAt: draftNow,
        });
        const sourceSnapshotHash = await ports.reviewSnapshotHash(sourceRun.id);
        if (!sourceSnapshotHash) {
          throw new RunConflictError("The source review snapshot is unavailable.");
        }
        await requireGit();
        const current = await git.snapshotHash(task.workingDirectory, task.baseCommit);
        if (current !== sourceSnapshotHash && !input.confirmStaleSnapshot) throw new StaleSnapshotError();
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

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/messages$/);
      if (parameters) {
        const task = await requireTask(parameters[0]!);
        if (method === "GET") return json(await ports.listMessages(task.id));
        if (method === "POST") {
          ensureAccepting();
          const input = await body(request, createTaskMessageRequestSchema);
          const provider = input.targetRole === "reviewer" ? task.reviewerProvider : task.developerProvider;
          await requireCli(provider);
          requireImageCapability(
            provider,
            input.targetRole === "reviewer" ? "reviewerResumeImage" : "developerResumeImage",
            input.attachmentIds,
          );
          try {
            return json(await conversations.enqueue({
              ...input,
              projectId: task.projectId,
              taskId: task.id,
            }), 202);
          } catch (error) {
            if (error instanceof AttachmentClaimConflictError || error instanceof PersistenceOwnershipError) {
              throw new RunConflictError(error.message);
            }
            throw error;
          }
        }
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/approvals$/);
      if (parameters && method === "GET") {
        await requireTask(parameters[0]!);
        return json(await ports.listApprovals(parameters[0]!));
      }

      parameters = match(path, /^\/api\/approvals\/([^/]+)\/decision$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        const input = await body(request, approvalDecisionRequestSchema);
        return json(await decideApproval(parameters[0]!, input.decision, input.reason ?? null));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/git\/(status|diff|files)$/);
      if (parameters && method === "GET") {
        const task = await requireTask(parameters[0]!);
        await requireGit();
        if (parameters[1] === "status") {
          const capture = await git.capture(task.workingDirectory, task.baseCommit);
          return json({ ...capture.status, snapshotHash: capture.snapshotHash });
        }
        if (parameters[1] === "diff") return json(await git.diff(task.workingDirectory, task.baseCommit));
        return json(await git.files(task.workingDirectory));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/git\/file-diff$/);
      if (parameters && method === "GET") {
        const task = await requireTask(parameters[0]!);
        const filePath = url.searchParams.get("path");
        if (!filePath) throw new RequestValidationError("path query parameter is required.");
        await requireGit();
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
        const task = await requireTask(parameters[0]!);
        const input = await body(request, selectFindingsRequestSchema);
        const sourceRun = await requireSuccessfulReviewRun(task, input.sourceReviewRunId);
        return json(await ports.selectFindings(task.id, sourceRun.id, input.mode));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/reviews\/([^/]+)\/feedback-draft$/);
      if (parameters && (method === "GET" || method === "PUT")) {
        const task = await requireTask(parameters[0]!);
        const sourceRun = await requireSuccessfulReviewRun(task, parameters[1]!);
        if (method === "GET") {
          return json({ draft: await ports.getFeedbackDraft(task.id, sourceRun.id) });
        }
        ensureAccepting();
        const input = await body(request, saveFeedbackDraftRequestSchema);
        const now = new Date().toISOString();
        return json(await ports.saveFeedbackDraft({
          taskId: task.id,
          sourceReviewRunId: sourceRun.id,
          finalText: input.finalText,
          createdAt: now,
          updatedAt: now,
        }));
      }

      parameters = match(path, /^\/api\/tasks\/([^/]+)\/feedback\/preview$/);
      if (parameters && method === "POST") {
        ensureAccepting();
        const task = await requireTask(parameters[0]!);
        const input = await body(request, feedbackPreviewRequestSchema);
        const { sourceRun, findings: available } = await feedbackFindings(task, input.sourceReviewRunId, input.selectedFindingIds);
        const selected = new Set(input.selectedFindingIds);
        const findings = available.map((finding) => ({ ...finding, selected: selected.has(finding.id) }));
        const finalText = composeFeedback(task, findings);
        const now = new Date().toISOString();
        await ports.saveFeedbackDraft({
          taskId: task.id,
          sourceReviewRunId: sourceRun.id,
          finalText,
          createdAt: now,
          updatedAt: now,
        });
        return json({ finalText });
      }

      return json({ code: "NOT_FOUND", message: "Route not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  try {
    await clis(true);
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { ports.releaseApplicationLease(); } finally { database.close(); }
    await codexReviewSchema.dispose();
    throw error;
  }

  if (leaseLost || !ports.heartbeatApplicationLease()) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { ports.releaseApplicationLease(); } finally { database.close(); }
    await codexReviewSchema.dispose();
    throw new Error("Flint lost ownership of its database during startup.");
  }

  async function shutdown(): Promise<void> {
    if (shutdownTask) return shutdownTask;
    accepting = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    shutdownTask = (async () => {
      const activeIds = [...active.keys()];
      try {
        await Promise.allSettled(activeIds.map((runId) => agentRuns.interrupt(runId)));
        await Promise.allSettled(activeIds.map((runId) => active.get(runId)).filter(Boolean) as Promise<AgentRun>[]);
        const stranded = await ports.recoverInterrupted(activeIds);
        for (const run of stranded) {
          try { await events.publish(eventFor(run, "run_interrupted", new Date().toISOString())); } catch { /* closing continues */ }
        }
      } finally {
        try { hub.closeAll(); } finally {
          try { ports.releaseApplicationLease(); } finally {
            database.close();
            await codexReviewSchema.dispose();
          }
        }
      }
    })();
    return shutdownTask;
  }

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    try {
      if (!ports.heartbeatApplicationLease()) void shutdown();
    } catch {
      // A transient SQLite lock can be retried on the next heartbeat; the lease still fences takeovers.
    }
  }, 1_000);
  heartbeatTimer.unref?.();

  return {
    hub,
    handle,
    socketOpen(socket) { hub.open(socket); },
    async socketMessage(socket, rawMessage) {
      const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { socket.close(1008, "Invalid subscription message"); return; }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.keys(parsed).length === 1
        && (parsed as { action?: unknown }).action === "subscribe_unfinished") {
        hub.beginUnfinished(socket);
        socket.send(JSON.stringify({ action: "subscribed_unfinished" }));
        return;
      }
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
    shutdown,
  };
}

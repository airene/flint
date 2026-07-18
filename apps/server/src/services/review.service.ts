import {
  reviewResultSchema,
  type AgentEvent,
  type AgentRun,
  type ReviewFinding,
  type ReviewResult,
  type Task,
} from "@local-pair-review/shared";
import type { StartAgentRunInput, StartedAgentRun } from "./agent-run.service";
import type { EventService } from "./event.service";

export interface ReviewSnapshot {
  snapshotHash: string;
  gitStatus: string;
  diffStat: string;
}

export interface ReviewContextPort {
  capture(task: Task): Promise<ReviewSnapshot>;
}

export interface ReviewPersistencePort {
  recordSnapshot(taskId: string, snapshotHash: string): Promise<void>;
  replaceFindings(taskId: string, runId: string, findings: ReviewFinding[]): Promise<void>;
  setParseStatus(run: AgentRun, status: "succeeded" | "failed"): Promise<AgentRun>;
}

export interface AgentRunStarterPort {
  start(input: StartAgentRunInput): Promise<StartedAgentRun>;
}

export interface ReviewOutcome {
  run: AgentRun;
  result: ReviewResult | null;
  findings: ReviewFinding[];
  stale: boolean;
  startSnapshotHash: string;
  endSnapshotHash: string;
}

export interface StartedReview {
  run: AgentRun;
  completion: Promise<ReviewOutcome>;
}

interface ReviewServiceOptions {
  agentRuns: AgentRunStarterPort;
  context: ReviewContextPort;
  persistence: ReviewPersistencePort;
  events: EventService;
  createId?: () => string;
  now?: () => string;
}

export function buildReviewPrompt(input: {
  task: Task;
  gitStatus: string;
  diffStat: string;
}): string {
  return `你是当前任务的独立代码 Reviewer。

只评审当前工作目录中的变更，不要修改文件。

原始开发任务：
${input.task.originalPrompt}

基准提交：
${input.task.baseCommit}

当前 Git 状态：
${input.gitStatus}

变更摘要：
${input.diffStat}

评审目标：
1. 功能正确性；
2. 数据丢失、权限绕过和安全问题；
3. 异常处理和边界条件；
4. 并发、事务和幂等问题；
5. API 与数据格式兼容性；
6. 测试覆盖；
7. 明确会影响维护性的设计问题。

严重等级：
- P0：可能造成严重安全事故、数据破坏、服务不可用或不可恢复问题；
- P1：明确功能缺陷、较高概率生产问题或必须修复的兼容性问题；
- P2：非阻塞的一般改进、可维护性或代码质量建议。

每个 Finding 必须独立并尽可能给出文件和行号；没有问题时 findings 返回空数组。输出必须符合给定 JSON Schema。`;
}

export class ReviewService {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: ReviewServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(task: Task): Promise<StartedReview> {
    const startSnapshot = await this.options.context.capture(task);
    await this.options.persistence.recordSnapshot(task.id, startSnapshot.snapshotHash);
    const started = await this.options.agentRuns.start({
      task,
      runType: "reviewer",
      prompt: buildReviewPrompt({ task, gitStatus: startSnapshot.gitStatus, diffStat: startSnapshot.diffStat }),
      sessionId: undefined,
    });
    return {
      run: started.run,
      completion: this.finishReview(task, started.completion, startSnapshot.snapshotHash),
    };
  }

  private async finishReview(
    task: Task,
    completion: Promise<AgentRun>,
    startSnapshotHash: string,
  ): Promise<ReviewOutcome> {
    const terminal = await completion;
    const endSnapshot = await this.options.context.capture(task);
    const stale = endSnapshot.snapshotHash !== startSnapshotHash;
    if (terminal.status !== "completed") {
      return {
        run: terminal,
        result: null,
        findings: [],
        stale,
        startSnapshotHash,
        endSnapshotHash: endSnapshot.snapshotHash,
      };
    }

    const parsed = reviewResultSchema.safeParse(terminal.structuredOutput);
    if (!parsed.success) {
      const run = await this.options.persistence.setParseStatus(terminal, "failed");
      await this.options.events.publish(this.reviewEvent(run, "review_parse_failed", {
        rawStructuredOutput: terminal.structuredOutput,
        issues: parsed.error.issues,
        stale,
        startSnapshotHash,
        endSnapshotHash: endSnapshot.snapshotHash,
      }));
      return {
        run,
        result: null,
        findings: [],
        stale,
        startSnapshotHash,
        endSnapshotHash: endSnapshot.snapshotHash,
      };
    }

    const findings = parsed.data.findings.map<ReviewFinding>((finding) => ({
      id: this.createId(),
      taskId: task.id,
      runId: terminal.id,
      ...finding,
      selected: finding.severity !== "P2",
      dismissed: false,
      userNote: null,
      createdAt: this.now(),
    }));
    await this.options.persistence.replaceFindings(task.id, terminal.id, findings);
    const run = await this.options.persistence.setParseStatus(terminal, "succeeded");
    await this.options.events.publish(this.reviewEvent(run, "review_parsed", {
      summary: parsed.data.summary,
      verdict: parsed.data.verdict,
      findingCount: findings.length,
      stale,
      startSnapshotHash,
      endSnapshotHash: endSnapshot.snapshotHash,
    }));
    return {
      run,
      result: parsed.data,
      findings,
      stale,
      startSnapshotHash,
      endSnapshotHash: endSnapshot.snapshotHash,
    };
  }

  private reviewEvent(run: AgentRun, type: AgentEvent["type"], payload: unknown): AgentEvent {
    return {
      sequence: 0,
      timestamp: this.now(),
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      source: "system",
      type,
      payload,
    };
  }
}

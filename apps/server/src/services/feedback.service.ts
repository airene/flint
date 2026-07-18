import type { AgentRun, FeedbackDelivery, ReviewFinding, Task } from "@local-pair-review/shared";
import type { AgentRunStarterPort } from "./review.service";

export interface ReserveFeedbackResult {
  delivery: FeedbackDelivery;
  allowStart: boolean;
}

export interface FeedbackDeliveryPersistencePort {
  /** Phase 3 implements this as an atomic duplicate check + draft insert/reuse. */
  reserve(candidate: FeedbackDelivery): Promise<ReserveFeedbackResult>;
  attachRun(deliveryId: string, runId: string): Promise<FeedbackDelivery>;
  markSent(deliveryId: string, sentAt: string): Promise<FeedbackDelivery>;
}

export class DuplicateFeedbackError extends Error {
  constructor() {
    super("This feedback delivery is already active or has already been sent.");
    this.name = "DuplicateFeedbackError";
  }
}

export interface SendFeedbackInput {
  task: Task;
  sourceReviewRunId: string;
  selectedFindingIds: string[];
  finalText: string;
}

export interface FeedbackCompletion {
  run: AgentRun;
  delivery: FeedbackDelivery;
}

export interface StartedFeedback {
  run: AgentRun;
  delivery: FeedbackDelivery;
  completion: Promise<FeedbackCompletion>;
}

interface FeedbackServiceOptions {
  agentRuns: AgentRunStarterPort;
  persistence: FeedbackDeliveryPersistencePort;
  createId?: () => string;
  now?: () => string;
}

function findingBlock(finding: ReviewFinding): string {
  const location = finding.startLine === null
    ? "未指定"
    : finding.endLine === null || finding.endLine === finding.startLine
      ? String(finding.startLine)
      : `${finding.startLine}-${finding.endLine}`;
  return `## ${finding.severity} - ${finding.title}

文件：${finding.file ?? "未指定"}
行号：${location}

问题：
${finding.description}

建议：
${finding.suggestion}

人工备注：
${finding.userNote ?? "无"}`;
}

export function composeFeedback(task: Task, findings: ReviewFinding[]): string {
  const selected = findings.filter((finding) => finding.selected && !finding.dismissed);
  return `下面是人工确认后需要处理的 Code Review 意见。

原始任务：
${task.originalPrompt}

${selected.map(findingBlock).join("\n\n")}

请逐项检查并处理。

要求：
1. 对认可的问题进行修复；
2. 补充必要的测试；
3. 对不认可的问题说明理由；
4. 不要修改与这些问题无关的代码；
5. 完成后总结每个问题的处理结果。`;
}

export class FeedbackService {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: FeedbackServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  preview(task: Task, findings: ReviewFinding[]): string {
    return composeFeedback(task, findings);
  }

  async send(input: SendFeedbackInput): Promise<StartedFeedback> {
    if (!input.task.developerSessionId) {
      throw new Error("Feedback requires the exact Codex session ID persisted on the task.");
    }

    const candidate: FeedbackDelivery = {
      id: this.createId(),
      taskId: input.task.id,
      sourceReviewRunId: input.sourceReviewRunId,
      targetDeveloperRunId: null,
      selectedFindingIds: [...input.selectedFindingIds],
      finalText: input.finalText,
      sentAt: null,
      createdAt: this.now(),
    };
    const reservation = await this.options.persistence.reserve(candidate);
    if (!reservation.allowStart) throw new DuplicateFeedbackError();

    const started = await this.options.agentRuns.start({
      task: input.task,
      runType: "developer_feedback",
      prompt: input.finalText,
      sessionId: input.task.developerSessionId,
    });
    const delivery = await this.options.persistence.attachRun(reservation.delivery.id, started.run.id);
    return {
      run: started.run,
      delivery,
      completion: this.finish(delivery, started.completion),
    };
  }

  private async finish(delivery: FeedbackDelivery, completion: Promise<AgentRun>): Promise<FeedbackCompletion> {
    const run = await completion;
    if (run.status !== "completed") return { run, delivery };
    return {
      run,
      delivery: await this.options.persistence.markSent(delivery.id, this.now()),
    };
  }
}

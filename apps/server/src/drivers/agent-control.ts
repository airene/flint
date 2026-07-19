import { isAbsolute } from "node:path";
import type {
  AgentEvent,
  AgentAvailability,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  Provider,
  ProviderCapabilities,
} from "@local-pair-review/shared";

export type ProviderCapability = keyof ProviderCapabilities;

export interface AgentControlStartRequest extends AgentStartRequest {
  imagePaths?: readonly string[];
}

export interface InterruptAcknowledgement {
  runId: string;
  status: "terminated" | "not_running";
}

export interface AgentControl {
  readonly capabilities: ProviderCapabilities;
  imageCapability(request: AgentStartRequest): ProviderCapability;
  interrupt(runId: string): Promise<InterruptAcknowledgement>;
  sendLiveMessage(runId: string, message: string): Promise<void>;
  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
}

export interface ControlledAgentDriver extends AgentControl {
  readonly provider: Provider;
  checkAvailability(): Promise<AgentAvailability>;
  start(
    request: AgentControlStartRequest,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<AgentStartResult>;
  cancel(runId: string): Promise<void>;
}

const capabilityReasons: Record<ProviderCapability, string> = {
  developerInitialImage: "developer initial-run images",
  developerResumeImage: "developer resumed-run images",
  reviewerInitialImage: "reviewer initial-run images",
  reviewerResumeImage: "reviewer resumed-run images",
  liveMessages: "live message delivery",
  interrupt: "run interruption",
  approvals: "structured approval responses",
};

export class UnsupportedProviderCapabilityError extends Error {
  readonly code = "UNSUPPORTED_PROVIDER_CAPABILITY" as const;

  constructor(
    readonly provider: Provider,
    readonly capability: ProviderCapability,
  ) {
    super(`${provider} does not support ${capabilityReasons[capability]} through its configured CLI protocol.`);
    this.name = "UnsupportedProviderCapabilityError";
  }
}

export class InvalidAgentControlRequestError extends Error {
  readonly code = "INVALID_AGENT_CONTROL_REQUEST" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentControlRequestError";
  }
}

export function imageCapability(request: AgentStartRequest): ProviderCapability {
  const reviewer = request.runType === "reviewer" || request.runType === "reviewer_followup";
  if (reviewer) return request.sessionId ? "reviewerResumeImage" : "reviewerInitialImage";
  return request.sessionId ? "developerResumeImage" : "developerInitialImage";
}

export function validateAgentControlStart(
  provider: Provider,
  capabilities: ProviderCapabilities,
  request: AgentControlStartRequest,
): void {
  const paths = request.imagePaths ?? [];
  if (paths.length === 0) return;

  const capability = imageCapability(request);
  if (!capabilities[capability]) throw new UnsupportedProviderCapabilityError(provider, capability);

  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new InvalidAgentControlRequestError(`Agent image paths must be absolute: ${path}`);
    }
  }
}

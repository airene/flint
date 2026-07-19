import { ZodError } from "zod";
import {
  ActiveProjectRunError,
  ConfirmationRequiredError,
  DuplicateProjectError,
} from "../services/project.service";
import {
  DirtyWorkingTreeError,
  CompletedTaskReadOnlyError,
  InvalidTaskTransitionError,
  ProjectWriteRunConflictError,
  TaskTransitionConflictError,
} from "../services/task.service";
import { DuplicateFeedbackError, StaleFeedbackLeaseError } from "../services/feedback.service";
import { GitCliExecutionError } from "../services/git.service";
import { InvalidAppSettingError } from "../services/app-settings.service";
import { GitRootValidationError } from "../utils/path";
import { UnsupportedProviderCapabilityError } from "../drivers/agent-control";

export class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

export class CliUnavailableError extends Error {
  constructor(readonly provider: "codex" | "claude" | "git", message: string) {
    super(message);
    this.name = "CliUnavailableError";
  }
}

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

export class StaleSnapshotError extends Error {
  constructor() {
    super("The working tree changed after review; explicit confirmation is required.");
    this.name = "StaleSnapshotError";
  }
}

export class ServiceShuttingDownError extends Error {
  constructor() {
    super("The service is shutting down and is not accepting new work.");
    this.name = "ServiceShuttingDownError";
  }
}

function isSqliteConstraintError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) || error.message.includes("constraint failed");
}

export function errorResponse(error: unknown): Response {
  if (error instanceof RequestValidationError || error instanceof InvalidAppSettingError) {
    return Response.json({ code: "VALIDATION_ERROR", message: error.message }, { status: 400 });
  }
  if (error instanceof ZodError || error instanceof GitRootValidationError) {
    return Response.json({ code: "VALIDATION_ERROR", message: "Invalid request.", details: error instanceof ZodError ? error.issues : undefined }, { status: 400 });
  }
  if (error instanceof NotFoundError) {
    return Response.json({ code: "NOT_FOUND", message: error.message }, { status: 404 });
  }
  if (
    error instanceof DuplicateProjectError
    || error instanceof ActiveProjectRunError
    || error instanceof ConfirmationRequiredError
    || error instanceof DirtyWorkingTreeError
    || error instanceof CompletedTaskReadOnlyError
    || error instanceof InvalidTaskTransitionError
    || error instanceof TaskTransitionConflictError
    || error instanceof ProjectWriteRunConflictError
    || error instanceof DuplicateFeedbackError
    || error instanceof StaleSnapshotError
    || error instanceof ServiceShuttingDownError
    || error instanceof RunConflictError
    || error instanceof StaleFeedbackLeaseError
    || error instanceof UnsupportedProviderCapabilityError
    || isSqliteConstraintError(error)
  ) {
    const details = error instanceof ConfirmationRequiredError ? error.data
      : error instanceof DirtyWorkingTreeError ? { files: error.files }
        : error instanceof StaleSnapshotError ? { reason: "STALE_SNAPSHOT" }
          : error instanceof UnsupportedProviderCapabilityError
            ? { provider: error.provider, capability: error.capability }
        : undefined;
    return Response.json({ code: "CONFLICT", message: error.message, ...(details ? { details } : {}) }, { status: 409 });
  }
  if (error instanceof CliUnavailableError || error instanceof GitCliExecutionError) {
    return Response.json({
      code: "CLI_UNAVAILABLE",
      message: error.message,
      details: { provider: error instanceof CliUnavailableError ? error.provider : "git" },
    }, { status: 422 });
  }
  return Response.json({ code: "INTERNAL_ERROR", message: "Internal server error." }, { status: 500 });
}

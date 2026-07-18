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
import { DuplicateFeedbackError } from "../services/feedback.service";
import { GitRootValidationError } from "../utils/path";

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

export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError || error instanceof SyntaxError || error instanceof GitRootValidationError) {
    return Response.json({ code: "VALIDATION_ERROR", message: "Invalid request.", details: error instanceof ZodError ? error.issues : undefined }, { status: 400 });
  }
  if (error instanceof NotFoundError || (error instanceof Error && /not found/i.test(error.message))) {
    return Response.json({ code: "NOT_FOUND", message: error instanceof Error ? error.message : "Resource not found." }, { status: 404 });
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
    || (error instanceof Error && /constraint failed|active .*run|stale feedback lease/i.test(error.message))
  ) {
    const details = error instanceof ConfirmationRequiredError ? error.data
      : error instanceof DirtyWorkingTreeError ? { files: error.files }
        : error instanceof StaleSnapshotError ? { reason: "STALE_SNAPSHOT" }
        : undefined;
    return Response.json({ code: "CONFLICT", message: error.message, ...(details ? { details } : {}) }, { status: 409 });
  }
  if (error instanceof CliUnavailableError) {
    return Response.json({ code: "CLI_UNAVAILABLE", message: error.message, details: { provider: error.provider } }, { status: 422 });
  }
  return Response.json({ code: "INTERNAL_ERROR", message: "Internal server error." }, { status: 500 });
}

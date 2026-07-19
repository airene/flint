import type { AgentRunType } from "@local-pair-review/shared";

export const reviewJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    verdict: { type: "string", enum: ["pass", "changes_suggested"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          title: { type: "string" },
          description: { type: "string" },
          suggestion: { type: "string" },
          file: { type: ["string", "null"] },
          startLine: { type: ["integer", "null"], minimum: 1 },
          endLine: { type: ["integer", "null"], minimum: 1 },
        },
        required: ["severity", "title", "description", "suggestion", "file", "startLine", "endLine"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "verdict", "findings"],
  additionalProperties: false,
} as const;

const ALLOWED_REVIEW_TOOLS = [
  "Read",
  "Glob",
  "Grep",
] as const;

const DENIED_REVIEW_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
] as const;

function isReviewer(runType: AgentRunType): boolean {
  return runType === "reviewer" || runType === "reviewer_followup";
}

export function buildCodexArgs(
  executable: string,
  runType: AgentRunType,
  sessionId?: string,
  reviewSchemaPath?: string,
  imagePaths: readonly string[] = [],
): string[] {
  const sandbox = isReviewer(runType) ? "read-only" : "workspace-write";
  const schemaArguments = isReviewer(runType) && reviewSchemaPath
    ? ["--output-schema", reviewSchemaPath]
    : [];
  const imageArguments = imagePaths.flatMap((path) => ["--image", path]);
  return sessionId
    ? [executable, "exec", "resume", sessionId, "--json", "-c", `sandbox_mode="${sandbox}"`, ...schemaArguments, ...imageArguments, "-"]
    : [executable, "exec", "--json", "--sandbox", sandbox, ...schemaArguments, ...imageArguments, "-"];
}

export function buildClaudeArgs(executable: string, runType: AgentRunType, sessionId?: string): string[] {
  if (!isReviewer(runType)) {
    const developerArgs = [
      executable,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ];
    if (sessionId) developerArgs.push("--resume", sessionId);
    return developerArgs;
  }
  const args = [
    executable,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--permission-mode",
    "plan",
    "--json-schema",
    JSON.stringify(reviewJsonSchema),
    "--tools",
    ...ALLOWED_REVIEW_TOOLS,
    "--allowedTools",
    ...ALLOWED_REVIEW_TOOLS,
    "--disallowedTools",
    ...DENIED_REVIEW_TOOLS,
  ];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

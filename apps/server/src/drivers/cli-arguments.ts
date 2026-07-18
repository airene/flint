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
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git ls-files *)",
] as const;

const DENIED_REVIEW_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(rm *)",
  "Bash(mv *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git clean *)",
  "Bash(git commit *)",
  "Bash(git push *)",
] as const;

export function buildCodexArgs(executable: string, sessionId?: string): string[] {
  return sessionId
    ? [executable, "exec", "resume", sessionId, "--json", "-c", 'sandbox_mode="workspace-write"', "-"]
    : [executable, "exec", "--json", "--sandbox", "workspace-write", "-"];
}

export function buildClaudeArgs(executable: string, sessionId?: string): string[] {
  const args = [
    executable,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "plan",
    "--json-schema",
    JSON.stringify(reviewJsonSchema),
    "--allowedTools",
    ...ALLOWED_REVIEW_TOOLS,
    "--disallowedTools",
    ...DENIED_REVIEW_TOOLS,
  ];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

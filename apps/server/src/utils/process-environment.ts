const REMOVED_CREDENTIALS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export function createCliEnvironment(
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) child[key] = value;
  }
  for (const key of REMOVED_CREDENTIALS) delete child[key];
  return child;
}

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  hostname: "127.0.0.1";
  port: number;
  databasePath: string;
  codexExecutable: string;
  claudeExecutable: string;
  gitExecutable: string;
  webRoot: string;
}

function executable(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!isAbsolute(value)) throw new Error(`Custom executable path must be absolute: ${value}`);
  return value;
}

export function loadConfig(environment: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const port = Number(environment.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535.");
  return {
    hostname: "127.0.0.1",
    port,
    databasePath: environment.LOCAL_PAIR_REVIEW_DATABASE ?? join(homedir(), ".local-pair-review", "data", "app.db"),
    codexExecutable: executable(environment.CODEX_EXECUTABLE, "codex"),
    claudeExecutable: executable(environment.CLAUDE_EXECUTABLE, "claude"),
    gitExecutable: executable(environment.GIT_EXECUTABLE, "git"),
    webRoot: environment.LOCAL_PAIR_REVIEW_WEB_ROOT
      ? executable(environment.LOCAL_PAIR_REVIEW_WEB_ROOT, "")
      : resolve(import.meta.dir, "../../web/dist"),
  };
}

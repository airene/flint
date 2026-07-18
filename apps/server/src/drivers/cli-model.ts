import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CliModelSource } from "@local-pair-review/shared";
import { createCliEnvironment } from "../utils/process-environment";
import { stopProcessTree } from "../utils/process-supervisor";

export interface CliModelMetadata {
  model: string | null;
  modelSource: CliModelSource | null;
  reasoningEffort: string | null;
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface CodexConfigResult {
  config?: {
    model?: unknown;
    model_reasoning_effort?: unknown;
  };
  origins?: Record<string, {
    name?: { type?: unknown };
  }>;
}

interface ClaudeSettings {
  model?: unknown;
  env?: { ANTHROPIC_MODEL?: unknown };
}

const EMPTY_METADATA: CliModelMetadata = {
  model: null,
  modelSource: null,
  reasoningEffort: null,
};

function modelSource(value: unknown): CliModelSource | null {
  if (value === "user") return "user_config";
  if (value === "project") return "project_config";
  if (value === "system") return "system_config";
  if (value === "sessionFlags") return "session_override";
  if (
    value === "mdm"
    || value === "enterpriseManaged"
    || value === "legacyManagedConfigTomlFromFile"
    || value === "legacyManagedConfigTomlFromMdm"
  ) return "managed_config";
  return null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readJsonRpcMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<JsonRpcMessage> {
  const decoder = new TextDecoder();
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      return JSON.parse(line) as JsonRpcMessage;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Codex app-server closed before returning configuration.");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

async function response(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
  id: number,
): Promise<JsonRpcMessage> {
  while (true) {
    const message = await readJsonRpcMessage(reader, state);
    if (message.id === id) return message;
  }
}

async function readCodexConfig(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  timeoutMs: number,
): Promise<CodexConfigResult | null> {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const spawned = Bun.spawn([executablePath, "app-server", "--listen", "stdio://"], {
      cwd,
      env: createCliEnvironment(environment),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: process.platform !== "win32",
    });
    child = spawned;
    reader = spawned.stdout.getReader();
    const state = { buffer: "" };
    const probe = (async () => {
      child!.stdin.write(`${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "flint", version: "1" },
          capabilities: { experimentalApi: true },
        },
      })}\n`);
      const initialized = await response(reader, state, 1);
      if (initialized.error) return null;
      child!.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      child!.stdin.write(`${JSON.stringify({
        id: 2,
        method: "config/read",
        params: { includeLayers: false },
      })}\n`);
      const configured = await response(reader!, state, 2);
      if (configured.error || !configured.result || typeof configured.result !== "object") return null;
      return configured.result as CodexConfigResult;
    })();
    const timedOut = new Promise<null>((resolveTimeout) => {
      timeout = setTimeout(() => {
        resolveTimeout(null);
      }, timeoutMs);
    });
    return await Promise.race([probe, timedOut]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (reader) await reader.cancel().catch(() => undefined);
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
      await stopProcessTree(child);
    }
  }
}

export async function resolveCodexModel(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  timeoutMs = 2_000,
): Promise<CliModelMetadata> {
  const result = await readCodexConfig(executablePath, environment, cwd, timeoutMs);
  if (!result) return EMPTY_METADATA;
  const model = string(result.config?.model);
  const reasoningEffort = string(result.config?.model_reasoning_effort);
  return {
    model: model ?? "default",
    modelSource: model
      ? modelSource(result.origins?.model?.name?.type)
      : "cli_default",
    reasoningEffort,
  };
}

async function settings(path: string): Promise<ClaudeSettings | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as ClaudeSettings : null;
  } catch {
    return null;
  }
}

function managedClaudeSettingsPath(
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | null {
  const override = string(environment.FLINT_CLAUDE_MANAGED_SETTINGS_PATH);
  if (override) return isAbsolute(override) ? override : resolve(cwd, override);
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "linux") return "/etc/claude-code/managed-settings.json";
  if (process.platform === "win32") {
    return join(environment.ProgramFiles ?? environment.PROGRAMFILES ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  }
  return null;
}

function configuredClaudeModel(value: ClaudeSettings | null, source: CliModelSource): CliModelMetadata | null {
  const environmentModel = string(value?.env?.ANTHROPIC_MODEL);
  if (environmentModel) return { model: environmentModel, modelSource: source, reasoningEffort: null };
  const model = string(value?.model);
  return model ? { model, modelSource: source, reasoningEffort: null } : null;
}

export async function resolveClaudeModel(
  environment: Readonly<Record<string, string | undefined>>,
  cwd = process.cwd(),
): Promise<CliModelMetadata> {
  const managedPath = managedClaudeSettingsPath(environment, cwd);
  const managed = managedPath ? configuredClaudeModel(await settings(managedPath), "managed_config") : null;
  if (managed) return managed;

  const environmentModel = string(environment.ANTHROPIC_MODEL);
  if (environmentModel) {
    return { model: environmentModel, modelSource: "environment", reasoningEffort: null };
  }

  const configuredDirectory = string(environment.CLAUDE_CONFIG_DIR);
  const configurationDirectory = configuredDirectory
    ? isAbsolute(configuredDirectory) ? configuredDirectory : resolve(cwd, configuredDirectory)
    : join(string(environment.HOME) ?? string(environment.USERPROFILE) ?? homedir(), ".claude");
  const user = configuredClaudeModel(await settings(join(configurationDirectory, "settings.json")), "user_config");
  return user ?? { model: "default", modelSource: "cli_default", reasoningEffort: null };
}

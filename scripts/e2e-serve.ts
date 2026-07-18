import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dataDirectory = await mkdtemp(join(tmpdir(), "flint-e2e-data-"));
const environment: Record<string, string | undefined> = {
  ...process.env,
  PORT: "4301",
  LOCAL_PAIR_REVIEW_DATABASE: join(dataDirectory, "data.sqlite"),
  CODEX_EXECUTABLE: resolve(root, "tests/fixtures/bin/codex"),
  CLAUDE_EXECUTABLE: resolve(root, "tests/fixtures/bin/claude"),
  CLAUDE_CONFIG_DIR: join(dataDirectory, "claude"),
  FLINT_CLAUDE_MANAGED_SETTINGS_PATH: join(dataDirectory, "managed-claude-settings.json"),
  ANTHROPIC_MODEL: undefined,
  FAKE_CLI_SCENARIO: "e2e",
};

const children = [
  Bun.spawn([process.execPath, "apps/server/src/index.ts"], { cwd: root, env: environment, stdin: "ignore", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn([
    resolve(root, "apps/web/node_modules/.bin/vite"),
    "--config", "e2e.vite.config.ts",
    "--port", "4302", "--strictPort",
  ], { cwd: resolve(root, "apps/web"), env: environment, stdin: "ignore", stdout: "inherit", stderr: "inherit" }),
];

let stopping: Promise<void> | null = null;
async function stop(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    const [server, vite] = children;
    vite.kill("SIGTERM");
    await vite.exited.catch(() => undefined);
    server.kill("SIGTERM");
    await server.exited.catch(() => undefined);
    await rm(dataDirectory, { recursive: true, force: true });
  })();
  return stopping;
}

process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

try {
  await Promise.race(children.map(async (child) => {
    const exitCode = await child.exited;
    if (!stopping) throw new Error(`E2E server child exited early with code ${exitCode}.`);
  }));
} finally {
  await stop();
}

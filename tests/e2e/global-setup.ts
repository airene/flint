import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");

async function waitForReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`E2E server exited early with code ${child.exitCode}.`);
    try {
      const [web, api] = await Promise.all([
        fetch("http://127.0.0.1:4302/"),
        fetch("http://127.0.0.1:4302/api/health"),
      ]);
      if (web.ok && api.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for the E2E server.");
}

export default async function globalSetup(_: FullConfig): Promise<() => Promise<void>> {
  const child = spawn("bun", ["run", "scripts/e2e-serve.ts"], {
    cwd: root,
    stdio: "inherit",
  });
  try {
    await waitForReady(child);
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    throw error;
  }
  return async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  };
}

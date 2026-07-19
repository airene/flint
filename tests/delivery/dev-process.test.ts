import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function availablePorts(): [number, number] {
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const ports: [number, number] = [first.port as number, second.port as number];
  first.stop(true);
  second.stop(true);
  return ports;
}

async function waitForHealth(port: number, exited: Promise<number>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok ? "ready" : "retry", () => "retry"),
      exited.then((exitCode) => `exited:${exitCode}`),
      Bun.sleep(50).then(() => "retry"),
    ]);
    if (outcome === "ready") return;
    if (outcome.startsWith("exited:")) throw new Error(`Development supervisor ${outcome}.`);
  }
  throw new Error("Development server did not become healthy before the timeout.");
}

async function waitForExit(exited: Promise<number>, timeoutMs = 5_000): Promise<number> {
  return Promise.race([
    exited,
    Bun.sleep(timeoutMs).then(() => { throw new Error("Development supervisor did not exit before the timeout."); }),
  ]);
}

function assertPortReleased(port: number): void {
  const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
  probe.stop(true);
}

test("development supervisor releases server and web ports on SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flint-dev-process-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const [serverPort, webPort] = availablePorts();
  const child = Bun.spawn([process.execPath, "scripts/dev.ts"], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PORT: String(serverPort),
      FLINT_WEB_PORT: String(webPort),
      LOCAL_PAIR_REVIEW_DATABASE: join(directory, "app.sqlite"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let finished = false;
  cleanups.push(async () => {
    if (finished) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The complete process group has already exited.
    }
    await child.exited.catch(() => undefined);
  });

  await waitForHealth(serverPort, child.exited);
  child.kill("SIGTERM");
  expect(await waitForExit(child.exited)).toBe(0);
  finished = true;

  assertPortReleased(serverPort);
  assertPortReleased(webPort);
});

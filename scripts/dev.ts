import { resolve } from "node:path";
import { stopProcessTree, type ManagedProcess } from "../apps/server/src/utils/process-supervisor";

interface DevelopmentChild {
  name: "server" | "web";
  process: ManagedProcess;
}

const root = resolve(import.meta.dir, "..");
const environment = { ...process.env };
const webPort = environment.FLINT_WEB_PORT ?? "5173";
const children: DevelopmentChild[] = [];

function spawn(name: DevelopmentChild["name"], command: string[], cwd: string): void {
  const process = Bun.spawn(command, {
    cwd,
    detached: true,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push({ name, process });
}

async function stopChildren(): Promise<void> {
  await Promise.all(children.map(({ process }) => stopProcessTree(process, 5_000)));
}

let requestStop!: (exitCode: number) => void;
const stopRequested = new Promise<number>((resolveStop) => { requestStop = resolveStop; });
let stopping = false;

function stop(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  requestStop(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { stop(0); });
}

let exitCode = 1;
try {
  spawn("server", [process.execPath, "--watch", "apps/server/src/index.ts"], root);
  spawn("web", [
    resolve(root, "apps/web/node_modules/.bin/vite"),
    "--port", webPort,
    "--strictPort",
  ], resolve(root, "apps/web"));

  for (const child of children) {
    void child.process.exited.then((childExitCode) => {
      if (stopping) return;
      console.error(`${child.name} development process exited unexpectedly with code ${childExitCode}.`);
      stop(childExitCode === 0 ? 1 : childExitCode);
    });
  }

  exitCode = await stopRequested;
} catch (error) {
  console.error("Unable to start the development processes:", error);
} finally {
  await stopChildren();
}

process.exit(exitCode);

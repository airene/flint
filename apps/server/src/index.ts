import { createApplication } from "./api/application";
import { loadConfig } from "./config";
import { createServer } from "./server";

const config = loadConfig();
const application = await createApplication({
  databasePath: config.databasePath,
  codexExecutable: config.codexExecutable,
  claudeExecutable: config.claudeExecutable,
  gitExecutable: config.gitExecutable,
});
const server = createServer({ port: config.port, application, webRoot: config.webRoot });

let shutdownTask: Promise<void> | null = null;
function shutdownAndExit(signal: NodeJS.Signals): void {
  if (shutdownTask) return;
  shutdownTask = (async () => {
    let exitCode = 0;
    try {
      await server.stop();
    } catch (error) {
      exitCode = 1;
      console.error(`Failed to shut down after ${signal}:`, error);
    }
    process.exit(exitCode);
  })();
}

process.once("SIGINT", () => { shutdownAndExit("SIGINT"); });
process.once("SIGTERM", () => { shutdownAndExit("SIGTERM"); });
process.once("SIGHUP", () => { shutdownAndExit("SIGHUP"); });

console.info(`Local Pair Review server listening on http://127.0.0.1:${server.port}`);

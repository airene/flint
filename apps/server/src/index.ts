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
const server = createServer({ port: config.port, application });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.stop();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

console.info(`Local Pair Review server listening on http://127.0.0.1:${server.port}`);

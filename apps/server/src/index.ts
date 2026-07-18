import { createServer } from "./server";

const port = Number(Bun.env.PORT ?? 3000);
const server = createServer({ port });

console.info(`Local Pair Review server listening on http://127.0.0.1:${server.port}`);

import { healthResponseSchema, webSocketSubscribeSchema } from "@local-pair-review/shared";
import type { LocalPairReviewApplication } from "./api/application";
import { forbiddenLocalRequestResponse, isAllowedLocalRequest } from "./api/security";

export interface LocalPairReviewServer {
  port: number;
  stop(): Promise<void>;
}

export function createServer(options: { port?: number; application?: LocalPairReviewApplication } = {}): LocalPairReviewServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);
      if (!isAllowedLocalRequest(request)) return forbiddenLocalRequestResponse();
      if (url.pathname === "/ws" && serverInstance.upgrade(request)) {
        return undefined;
      }

      if (options.application) return options.application.handle(request);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return Response.json(healthResponseSchema.parse({ status: "ok" }));
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        options.application?.socketOpen(socket);
      },
      async message(socket, rawMessage) {
        if (options.application) {
          await options.application.socketMessage(socket, rawMessage);
          return;
        }
        if (typeof rawMessage !== "string") {
          socket.close(1008, "Subscription must be JSON text");
          return;
        }

        let message: unknown;
        try {
          message = JSON.parse(rawMessage);
        } catch {
          socket.close(1008, "Invalid subscription message");
          return;
        }

        const subscription = webSocketSubscribeSchema.safeParse(message);
        if (!subscription.success) {
          socket.close(1008, "Invalid subscription message");
          return;
        }

        socket.send(JSON.stringify({
          action: "subscribed",
          taskId: subscription.data.taskId,
          afterSequence: subscription.data.afterSequence,
        }));
      },
      close(socket) {
        options.application?.socketClose(socket);
      },
    },
  });

  return {
    port: server.port as number,
    async stop() {
      try {
        await options.application?.shutdown();
      } finally {
        server.stop(true);
      }
    },
  };
}

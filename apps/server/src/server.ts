import { healthResponseSchema, webSocketSubscribeSchema } from "@local-pair-review/shared";

export interface LocalPairReviewServer {
  port: number;
  stop(): void;
}

export function createServer(options: { port?: number } = {}): LocalPairReviewServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request, serverInstance) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return Response.json(healthResponseSchema.parse({ status: "ok" }));
      }

      if (url.pathname === "/ws" && serverInstance.upgrade(request)) {
        return undefined;
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(socket, rawMessage) {
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
    },
  });

  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

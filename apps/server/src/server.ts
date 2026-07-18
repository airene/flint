import { healthResponseSchema, webSocketSubscribeSchema } from "@local-pair-review/shared";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { LocalPairReviewApplication } from "./api/application";
import { forbiddenLocalRequestResponse, isAllowedLocalRequest } from "./api/security";

export interface LocalPairReviewServer {
  port: number;
  stop(): Promise<void>;
}

async function staticResponse(webRoot: string, pathname: string, method: string): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const requested = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const target = resolve(webRoot, requested);
  const fromRoot = relative(webRoot, target);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return new Response("Not found", { status: 404 });

  const responseFor = async (path: string): Promise<Response | null> => {
    try {
      if (!(await stat(path)).isFile()) return null;
      const file = Bun.file(path);
      return new Response(method === "HEAD" ? null : file, {
        headers: { "content-type": file.type || "application/octet-stream" },
      });
    } catch {
      return null;
    }
  };

  const direct = await responseFor(target);
  if (direct) return direct;
  if (extname(decodedPath)) return new Response("Not found", { status: 404 });
  return (await responseFor(resolve(webRoot, "index.html"))) ?? new Response("Not found", { status: 404 });
}

export function createServer(options: { port?: number; application?: LocalPairReviewApplication; webRoot?: string } = {}): LocalPairReviewServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);
      if (!isAllowedLocalRequest(request)) return forbiddenLocalRequestResponse();
      if (url.pathname === "/ws" && serverInstance.upgrade(request)) {
        return undefined;
      }

      if (options.application && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
        return options.application.handle(request);
      }
      if (options.webRoot) {
        const response = await staticResponse(options.webRoot, url.pathname, request.method);
        if (response) return response;
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

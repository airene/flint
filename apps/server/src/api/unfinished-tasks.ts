import type { UnfinishedTaskService } from "../services/unfinished-task.service";

export const unfinishedTasksPath = "/api/tasks/unfinished";

export type UnfinishedTasksRoute = (request: Request) => Promise<Response | null>;

/**
 * Returns a small route handler that can be composed before the generic
 * `/api/tasks/:taskId` route without coupling this module to application setup.
 */
export function createUnfinishedTasksRoute(service: UnfinishedTaskService): UnfinishedTasksRoute {
  return async (request) => {
    if (new URL(request.url).pathname !== unfinishedTasksPath) return null;
    if (request.method !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    return Response.json(await service.list());
  };
}

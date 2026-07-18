import { expect, test } from "bun:test";
import * as serverModule from "./server";

type RunningServer = {
  port: number;
  stop: () => void;
};

type ServerFactory = (options?: { port?: number }) => RunningServer;

const createServer = (serverModule as { createServer?: ServerFactory }).createServer;

test("health endpoint reports a healthy local server", async () => {
  expect(createServer).toBeDefined();
  if (!createServer) return;

  const server = createServer({ port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  } finally {
    server.stop();
  }
});

test("websocket rejects a subscribe handshake without a task id", async () => {
  expect(createServer).toBeDefined();
  if (!createServer) return;

  const server = createServer({ port: 0 });
  try {
    const close = await new Promise<CloseEvent>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ action: "subscribe", afterSequence: 0 })));
      socket.addEventListener("close", resolve);
      socket.addEventListener("error", () => reject(new Error("socket error")));
    });
    expect(close.code).toBe(1008);
  } finally {
    server.stop();
  }
}, 1_000);

test("websocket confirms a valid subscribe handshake", async () => {
  expect(createServer).toBeDefined();
  if (!createServer) return;

  const server = createServer({ port: 0 });
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ action: "subscribe", taskId: "task_1", afterSequence: 2 })));
      socket.addEventListener("message", (event) => {
        socket.close();
        resolve(JSON.parse(String(event.data)));
      });
      socket.addEventListener("error", () => reject(new Error("socket error")));
    });
    expect(response).toEqual({ action: "subscribed", taskId: "task_1", afterSequence: 2 });
  } finally {
    server.stop();
  }
}, 1_000);

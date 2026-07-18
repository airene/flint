import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

test("uses the spec data directory and resolves the built web root", () => {
  const config = loadConfig({});

  expect(config.databasePath).toBe(join(homedir(), ".local-pair-review", "data", "app.db"));
  expect(config.webRoot).toEndWith(join("apps", "web", "dist"));
});

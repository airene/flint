import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const codexFixture = resolve(root, "tests/fixtures/bin/codex");

test("real CLI smoke authorization accepts a single line without waiting for stdin EOF", async () => {
  const child = Bun.spawn([process.execPath, "run", "scripts/smoke.ts", "codex"], {
    cwd: root,
    env: { ...process.env, CODEX_EXECUTABLE: codexFixture, FAKE_CLI_SCENARIO: "normal" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("NO\n");

  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    Bun.sleep(750).then(() => ({ exitCode: -1, timedOut: true })),
  ]);
  if (outcome.timedOut) child.kill("SIGTERM");
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(outcome.timedOut).toBe(false);
  expect(outcome.exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("Smoke test not authorized; no real subscription command was invoked.");
});

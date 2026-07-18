import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewJsonSchema } from "./cli-arguments";

export interface TemporaryCodexReviewSchema {
  path: string;
  dispose(): Promise<void>;
}

/** The schema stays available until application shutdown, including review resumes. */
export async function createTemporaryCodexReviewSchema(): Promise<TemporaryCodexReviewSchema> {
  const directory = await mkdtemp(join(tmpdir(), "local-pair-review-codex-schema-"));
  const path = join(directory, "review-output-schema.json");
  await Bun.write(path, JSON.stringify(reviewJsonSchema));
  return {
    path,
    async dispose() { await rm(directory, { recursive: true, force: true }); },
  };
}

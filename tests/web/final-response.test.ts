import { describe, expect, test } from "bun:test";
import { looksLikeMarkdown } from "../../apps/web/src/components/final-response";

describe("looksLikeMarkdown", () => {
  test("recognizes explicit block and inline Markdown structures", () => {
    const markdownSamples = [
      "# Summary\nDone",
      "- changed one file\n- ran the test",
      "1. inspect\n2. update",
      "> Important note",
      "```ts\nconst ready = true;\n```",
      "| Check | Result |\n| --- | --- |\n| tests | pass |",
      "Run `bun test` next.",
      "**Completed** successfully.",
      "See [the docs](https://example.com).",
    ];

    for (const sample of markdownSamples) expect(looksLikeMarkdown(sample)).toBe(true);
  });

  test("keeps ordinary text, logs, JSON, and ambiguous punctuation as plain text", () => {
    const plainSamples = [
      "Completed successfully.",
      "Completed successfully.\nNo further action is required.",
      '{\n  "status": "completed"\n}',
      "Error: command failed\n    at run (/tmp/task.ts:12:4)",
      "/Users/example/project/src/index.ts",
      "Calculated 2 * 3 = 6.",
      "",
    ];

    for (const sample of plainSamples) expect(looksLikeMarkdown(sample)).toBe(false);
  });
});

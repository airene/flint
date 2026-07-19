import { describe, expect, test } from "bun:test";
import { activeFileMention, replaceFileMention } from "../../apps/web/src/components/file-mention";

describe("file mention helper", () => {
  test("finds triggers only at text boundaries and uses text before the caret as the query", () => {
    expect(activeFileMention("@src/app", 0)).toBeNull();
    expect(activeFileMention("@src/app", 8)).toMatchObject({ start: 0, end: 8, query: "src/app", quoted: false });
    expect(activeFileMention("See (@src/app.ts)", 13)).toMatchObject({ start: 5, end: 16, query: "src/app", quoted: false });
    expect(activeFileMention("mail@example.com", 16)).toBeNull();
    expect(activeFileMention("prefix@src/app", 14)).toBeNull();
  });

  test("keeps the whole active token when editing in the middle", () => {
    expect(activeFileMention("Read @src/exampel.ts next", 13)).toEqual({
      start: 5,
      end: 20,
      query: "src/exa",
      quoted: false,
    });
    expect(activeFileMention('Read @"docs/design notes.md" next', 19)).toEqual({
      start: 5,
      end: 28,
      query: "docs/design ",
      quoted: true,
    });
  });

  test("replaces only the active mention and quotes paths containing spaces", () => {
    const plainText = "Read @src/exampel.ts next";
    const plain = activeFileMention(plainText, 13)!;
    expect(replaceFileMention(plainText, plain, "src/example.ts")).toEqual({
      value: "Read @src/example.ts next",
      caret: 21,
    });

    const quotedText = 'Read @"docs/old notes.md" next';
    const quoted = activeFileMention(quotedText, 15)!;
    expect(replaceFileMention(quotedText, quoted, "docs/design notes.md")).toEqual({
      value: 'Read @"docs/design notes.md" next',
      caret: 29,
    });
  });
});

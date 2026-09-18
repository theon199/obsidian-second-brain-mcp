import { describe, expect, it } from "vitest";
import {
  LIFE_TODOS_PATH,
  PARA_ROOTS,
  assertSafeVaultPath,
  buildParaDestination,
  ensureMdExtension,
  filterLinesUnderRoot,
  inboxCapturePath,
  isUnderParaRoot,
  paraPropertyDefaults,
  seedNotes,
  slugify,
} from "../src/para.js";

describe("para conventions", () => {
  it("slugifies titles and builds inbox capture paths", () => {
    expect(slugify("Hello, World!")).toBe("Hello-World");
    expect(inboxCapturePath("Buy milk")).toBe("Inbox/Buy-milk.md");
    expect(ensureMdExtension("Projects/x")).toBe("Projects/x.md");
  });

  it("builds PARA destinations and rejects unsafe paths", () => {
    expect(
      buildParaDestination({ category: "project", name: "Website Redesign", sourcePath: "Inbox/idea.md" }),
    ).toBe("Projects/Website-Redesign/idea.md");
    expect(buildParaDestination({ category: "inbox", sourcePath: "Projects/Old/note.md" })).toBe(
      "Inbox/note.md",
    );
    expect(buildParaDestination({ category: "archive", sourcePath: "Areas/Health/note.md" })).toBe(
      "Archives/note.md",
    );
    expect(() => buildParaDestination({ category: "project", sourcePath: "Inbox/a.md" })).toThrow(
      /requires a name/,
    );
    expect(() => assertSafeVaultPath("../secret.md")).toThrow(/relative/);
    expect(isUnderParaRoot("Projects/Foo/a.md")).toBe(true);
    expect(isUnderParaRoot("Random/a.md")).toBe(false);
  });

  it("exposes seed notes and property defaults", () => {
    const seeds = seedNotes();
    expect(seeds.map((seed) => seed.path)).toEqual(
      expect.arrayContaining([...PARA_ROOTS.map((root) => `${root}/README.md`), LIFE_TODOS_PATH]),
    );
    expect(paraPropertyDefaults("area", "Health")).toEqual({
      para: "area",
      status: "active",
      area: "Health",
    });
    expect(filterLinesUnderRoot(["Inbox/a.md", "Projects/b.md", "other.md"], "Inbox")).toEqual([
      "Inbox/a.md",
    ]);
  });
});

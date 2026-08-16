import { describe, expect, it } from "vitest";
import {
  commandName,
  digest,
  inferTargets,
  isMutation,
  isVaultRelativePath,
  sanitizeForAudit,
  validateGenericArgs,
} from "../src/safety.js";

describe("generic command safety", () => {
  it("finds the command while ignoring a vault selector", () => {
    expect(commandName(["vault=Personal", "search", "query=idea"])).toBe("search");
    expect(commandName(["vault=Personal"])).toBe("");
  });

  it.each([
    ["eval", "arbitrary JavaScript eval"],
    ["dev:eval", "raw developer-control"],
    ["devtools", "raw developer-control"],
    ["delete", "Permanent deletion"],
  ])("rejects %s", (command, expected) => {
    const args = command === "delete" ? [command, "permanent"] : [command];
    expect(() => validateGenericArgs(args)).toThrow(expected);
  });

  it("rejects empty arguments and NUL bytes", () => {
    expect(() => validateGenericArgs([])).toThrow("At least one");
    expect(() => validateGenericArgs(["search", "query=bad\0value"])).toThrow("NUL");
  });

  it("blocks vault overrides and paths outside the configured vault", () => {
    expect(() => validateGenericArgs(["vault=Other", "search", "query=idea"])).toThrow(
      "vault overrides",
    );
    expect(() => validateGenericArgs(["read", "path=/tmp/secret.md"])).toThrow(
      "relative to the configured vault",
    );
    expect(() => validateGenericArgs(["move", "path=Notes/idea.md", "to=../secret.md"])).toThrow(
      "relative to the configured vault",
    );
    expect(isVaultRelativePath("Notes/idea.md")).toBe(true);
    expect(isVaultRelativePath("../idea.md")).toBe(false);
  });

  it("permits trash-style delete and classifies read-only commands", () => {
    expect(() => validateGenericArgs(["delete", "path=Notes/idea.md"])).not.toThrow();
    expect(isMutation(["vault=Personal", "search", "query=idea"])).toBe(false);
    expect(isMutation(["create", "path=Notes/idea.md"])).toBe(true);
  });
});

describe("audit sanitization", () => {
  it("redacts content fields without losing useful metadata", () => {
    const value = sanitizeForAudit({
      path: "Notes/idea.md",
      content: "private note body",
      nested: { body: "another secret" },
      args: ["append", "content=private note body"],
    }) as Record<string, unknown>;

    expect(value.path).toBe("Notes/idea.md");
    expect(value.content).toEqual({
      redacted: true,
      length: "private note body".length,
      sha256: digest("private note body"),
    });
    expect(value.nested).toEqual({
      body: {
        redacted: true,
        length: "another secret".length,
        sha256: digest("another secret"),
      },
    });
    expect(value.args).toEqual([
      "append",
      `content=<redacted length=17 sha256=${digest("private note body")}>`,
    ]);
    expect(JSON.stringify(value)).not.toContain("private note body");
  });

  it("redacts text keys and infers unique target paths", () => {
    expect(sanitizeForAudit({ text: "secret" })).toEqual({
      text: { redacted: true, length: 6, sha256: digest("secret") },
    });
    expect(inferTargets({ path: "one.md", file: "one.md", destination: "two.md", other: "ignored" })).toEqual([
      "one.md",
      "two.md",
    ]);
    expect(inferTargets({ args: ["move", "path=one.md", "to=Archive/one.md", "content=ignored"] })).toEqual([
      "one.md",
      "Archive/one.md",
    ]);
    expect(inferTargets("not an object")).toEqual([]);
  });
});

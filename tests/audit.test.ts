import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAuditLogger } from "../src/audit.js";
import type { AuditEntry } from "../src/types.js";

const tempDirs: string[] = [];

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  timestamp: "2026-08-15T00:00:00.000Z",
  tool: "update_note",
  targets: ["Notes/idea.md"],
  arguments: { path: "Notes/idea.md", content: { redacted: true, length: 4, sha256: "hash" } },
  status: "success",
  durationMs: 3,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlAuditLogger", () => {
  it("creates a private parent directory and appends one JSON object per line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-mcp-audit-"));
    tempDirs.push(directory);
    const path = join(directory, "nested", "audit.jsonl");
    const logger = new JsonlAuditLogger(path);

    await logger.write(entry());
    await logger.write(entry({ status: "error", error: "simulated failure" }));

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "update_note", status: "success" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ tool: "update_note", status: "error", error: "simulated failure" });
  });

  it("does not write note bodies unless the caller includes them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-mcp-audit-"));
    tempDirs.push(directory);
    const path = join(directory, "audit.jsonl");
    await new JsonlAuditLogger(path).write(entry());
    const content = await readFile(path, "utf8");
    expect(content).not.toContain("private note body");
    expect(content).toContain('"redacted":true');
  });
});

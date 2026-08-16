import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAuditLogger } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { runChecked, ObsidianCliRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";

const smokeEnabled = process.env.OBSIDIAN_MCP_RUN_SMOKE === "1";
const configuredBinary = process.env.OBSIDIAN_BIN || "obsidian";
const obsidianAvailable = !smokeEnabled
  ? false
  : configuredBinary.includes("/")
    ? existsSync(configuredBinary)
    : spawnSync("which", [configuredBinary], { stdio: "ignore" }).status === 0;

describe.skipIf(!smokeEnabled || !obsidianAvailable)("real Obsidian smoke test (opt-in)", () => {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates, links, searches, reads, updates, and trashes isolated fixture notes", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "obsidian-mcp-smoke-"));
    cleanupDirectories.push(tempDirectory);
    const auditPath = join(tempDirectory, "audit.jsonl");
    const config = await loadConfig({
      ...process.env,
      OBSIDIAN_BIN: configuredBinary,
      OBSIDIAN_MCP_AUDIT_LOG: auditPath,
    });
    const runner = new ObsidianCliRunner(config);
    const server = buildServer({ executor: runner, audit: new JsonlAuditLogger(auditPath), defaultVault: config.vault });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "obsidian-mcp-smoke", version: "1.0.0" });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const a = `MCP Smoke/${id}-A.md`;
    const b = `MCP Smoke/${id}-B.md`;
    const aLink = `MCP Smoke/${id}-A`;
    const bLink = `MCP Smoke/${id}-B`;
    let createdA = false;
    let createdB = false;

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result;
    };

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await call("create_note", {
        path: a,
        content: `# Smoke A\n\nSee [[${bLink}]].\n\n- [ ] smoke task\n`,
        overwrite: true,
      });
      createdA = true;
      await call("create_note", {
        path: b,
        content: `# Smoke B\n\nBack to [[${aLink}]].\n`,
        overwrite: true,
      });
      createdB = true;

      const read = await call("read_note", { path: a });
      expect(JSON.stringify(read.structuredContent)).toContain("Smoke A");
      const search = await call("search_notes", { query: id, context: true, limit: 10 });
      expect(JSON.stringify(search.structuredContent)).toContain(id);
      const backlinks = await call("run_obsidian_command", {
        args: ["backlinks", `path=${a}`, "format=json", "counts"],
      });
      expect(JSON.stringify(backlinks.structuredContent)).toContain(id);
      await call("update_note", { path: a, setProperties: { smoke: true }, task: { line: 5, done: true } });
      const tasks = await call("manage_tasks", { action: "list", path: a, filter: "all" });
      expect(JSON.stringify(tasks.structuredContent)).toContain("smoke task");
      await call("organize_note", { path: b, action: "trash" });
      createdB = false;
      await call("organize_note", { path: a, action: "trash" });
      createdA = false;

      const audit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; arguments: unknown });
      expect(audit.map((entry) => entry.tool)).toEqual(
        expect.arrayContaining(["create_note", "update_note", "organize_note"]),
      );
      expect(JSON.stringify(audit)).not.toContain("Smoke A");
      expect(JSON.stringify(audit)).not.toContain("Back to");
    } finally {
      await client.close().catch(() => undefined);
      await server.close?.().catch(() => undefined);
      for (const [path, created] of [[a, createdA], [b, createdB]] as const) {
        if (!created) continue;
        await runChecked(runner, ["delete", `path=${path}`]).catch(() => undefined);
      }
    }

    await expect(runChecked(runner, ["file", `path=${a}`])).rejects.toThrow();
    await expect(runChecked(runner, ["file", `path=${b}`])).rejects.toThrow();
  }, 120_000);
});

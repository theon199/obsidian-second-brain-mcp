import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { NoopAuditLogger } from "../src/audit.js";
import type { CommandResult, ObsidianExecutor } from "../src/types.js";

const commandResult = (args: readonly string[], stdout: string): CommandResult => ({
  args: [...args],
  stdout,
  stderr: "",
  exitCode: 0,
  durationMs: 1,
});

describe("MCP contract", () => {
  const clients: Client[] = [];
  const servers: Array<{ close?: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map((server) => server.close?.() ?? Promise.resolve()));
  });

  it("initializes, lists all typed tools, exposes annotations, and calls search through a fake executor", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) =>
        commandResult(args, JSON.stringify([{ path: "Notes/idea.md", line: 2, text: "idea" }])),
      ),
    };
    const server = buildServer({ executor, audit: new NoopAuditLogger(), defaultVault: "Personal" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    clients.push(client);
    servers.push(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listing = await client.listTools();
    const names = listing.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "vault_overview",
      "search_notes",
      "read_note",
      "create_note",
      "update_note",
      "organize_note",
      "daily_note",
      "manage_tasks",
      "suggest_use_cases",
      "run_obsidian_command",
    ]);
    const searchTool = listing.tools.find((tool) => tool.name === "search_notes");
    expect(searchTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(searchTool?.inputSchema).toMatchObject({ type: "object" });

    const call = await client.callTool({
      name: "search_notes",
      arguments: { query: "idea", context: false, limit: 5 },
    });
    expect(call.isError).not.toBe(true);
    expect(call.structuredContent).toMatchObject({
      ok: true,
      data: [{ path: "Notes/idea.md", line: 2, text: "idea" }],
    });
    expect(executor.run).toHaveBeenCalledWith(
      ["search", "query=idea", "limit=5", "format=json"],
      { vault: "Personal" },
    );
  });

  it("returns an MCP error for blocked generic commands without invoking the executor", async () => {
    const executor: ObsidianExecutor = {
      run: vi.fn(async (args: readonly string[]) => commandResult(args, "unexpected")),
    };
    const server = buildServer({ executor, audit: new NoopAuditLogger() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    clients.push(client);
    servers.push(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await client.callTool({
      name: "run_obsidian_command",
      arguments: { args: ["eval", "code=alert(1)"] },
    });
    expect(call.isError).toBe(true);
    expect(call.content).toEqual([
      { type: "text", text: "The generic tool blocks arbitrary JavaScript eval." },
    ]);
    expect(executor.run).not.toHaveBeenCalled();
  });
});
